#!/usr/bin/env node

/**

 * OpenCode SSE 桥接：监听 /global/event，上报 kb.tool_call / kb.graph_query / kb.artifact_read

 * 通过 trace-registry 与工台 BFF trace 贯通；连接失败时自动重试

 */

import { readTelemetryConfig } from '../lib/config.mjs'

import { lookupHostSession } from '../lib/trace-registry.mjs'

import { emitToolCall, flush, emitTurnClosed } from '../client/index.mjs'

import { createSessionContext } from '../client/session.mjs'



const cfg = readTelemetryConfig()

const baseUrl = String(process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4098').replace(/\/+$/, '')

function buildOpencodeFetchHeaders(env = process.env, extra = {}) {
  const headers = { Accept: 'text/event-stream', ...extra }
  const username = String(env.OPENCODE_SERVER_USERNAME || 'opencode').trim()
  const password = String(env.OPENCODE_SERVER_PASSWORD || '').trim()
  if (password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  }
  const directory = String(env.OPENCODE_WORKSPACE_DIRECTORY || env.OPENCODE_DIRECTORY || '').trim()
  if (directory) {
    headers['x-opencode-directory'] = directory
  }
  return headers
}

function sleep(ms) {

  return new Promise((resolve) => setTimeout(resolve, ms))

}



function extractPathFromUnknown(value, depth = 0) {

  if (depth > 4 || value == null) return null

  if (typeof value === 'string') {

    const s = value.trim()

    if (/\.(java|kt|json|md|yaml|yml|ts|tsx|ets|json5)$/i.test(s) || s.includes('/') || s.includes('\\')) {

      return s

    }

    return null

  }

  if (Array.isArray(value)) {

    for (const item of value) {

      const found = extractPathFromUnknown(item, depth + 1)

      if (found) return found

    }

    return null

  }

  if (typeof value === 'object') {

    for (const key of ['path', 'file', 'filename', 'url', 'source', 'pattern', 'glob']) {

      if (key in value) {

        const found = extractPathFromUnknown(value[key], depth + 1)

        if (found) return found

      }

    }

    for (const v of Object.values(value)) {

      const found = extractPathFromUnknown(v, depth + 1)

      if (found) return found

    }

  }

  return null

}



function normalizeToolPartState(part) {
  const nested = part?.state
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested
  }
  return null
}

function parseToolOutput(part) {
  const nested = normalizeToolPartState(part)
  const raw = part?.output ?? part?.result ?? part?.content ?? nested?.output ?? nested?.result ?? null
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return { text: trimmed }
    }
  }
  return null
}

function isToolPartCompleted(part) {
  const nested = normalizeToolPartState(part)
  const status = String(nested?.status || part?.status || '').toLowerCase()
  if (status.includes('complete') || status.includes('done') || status === 'success') return true
  if (typeof part?.state === 'string') {
    const state = part.state.toLowerCase()
    if (state.includes('complete') || state.includes('output') || state.includes('done')) return true
  }
  return parseToolOutput(part) != null
}

function parseToolFromPart(part) {
  if (!part || typeof part !== 'object') return null

  const type = String(part.type || '').toLowerCase()
  if (!type.includes('tool')) return null
  if (!isToolPartCompleted(part)) return null

  const nested = normalizeToolPartState(part)
  const toolName =
    String(part.tool || part.name || part.toolName || part.title || part.type || 'tool').trim() || 'tool'
  const rawPath = extractPathFromUnknown(
    part.input || part.arguments || part.args || nested?.input || part,
  )
  const toolResult = parseToolOutput(part)
  const partId = String(part.id || part.partID || `${toolName}::${rawPath || ''}`)

  return { toolName, rawPath, toolResult, partId }
}



function parseSseLine(line) {

  if (!line.startsWith('data: ')) return null

  const json = line.slice(6).trim()

  if (!json || json === '[DONE]') return null

  try {

    const parsed = JSON.parse(json)

    const candidate = typeof parsed.payload === 'object' && parsed.payload !== null ? parsed.payload : parsed

    if (typeof candidate.type === 'string') return candidate

  } catch {

    return null

  }

  return null

}



const sessionTrace = new Map()

const emittedToolParts = new Map()



function resolveTrace(sessionId) {

  const bound = lookupHostSession(sessionId, process.env)

  if (bound) {

    return {
      traceId: bound.traceId,
      turnId: bound.turnId,
      consumer: bound.consumer || 'opencode-bridge',
      featureId: bound.featureId || null,
    }

  }

  if (!sessionTrace.has(sessionId)) {

    const ctx = createSessionContext()

    sessionTrace.set(sessionId, ctx)

  }

  const ctx = sessionTrace.get(sessionId)

  return { traceId: ctx.traceId, turnId: ctx.turnId, consumer: 'opencode-bridge', featureId: null }

}



async function handleEvent(event) {

  const props = event.properties || {}

  const sessionId = props.sessionID || props.sessionId

  if (!sessionId) return



  const { traceId, turnId, consumer, featureId } = resolveTrace(sessionId)

  const options = {
    env: process.env,
    consumer,
    traceId,
    turnId,
    featureId: featureId || undefined,
  }



  if (event.type === 'message.part.updated') {

    const part = props.part

    const tool = parseToolFromPart(part)

    if (tool) {
      const seen = emittedToolParts.get(sessionId) || new Set()
      if (seen.has(tool.partId)) return
      seen.add(tool.partId)
      emittedToolParts.set(sessionId, seen)

      await emitToolCall(tool.toolName, tool.rawPath, {
        ...options,
        toolResult: tool.toolResult,
        responseChars: tool.toolResult ? JSON.stringify(tool.toolResult).length : 0,
      })
    }

  }



  if (event.type === 'message.updated') {

    const info = props.info || {}

    if (info.role === 'assistant' && (info.finish === 'stop' || info.finish === 'tool')) {

      const bound = lookupHostSession(sessionId, process.env)

      if (!bound) {

        await emitTurnClosed({ traceId, turnId, status: 'done', consumer, env: process.env })

      }

      sessionTrace.delete(sessionId)
      emittedToolParts.delete(sessionId)

    }

  }



  if (event.type === 'session.idle') {

    const bound = lookupHostSession(sessionId, process.env)

    if (!bound) {

      await emitTurnClosed({ traceId, turnId, status: 'idle', consumer, env: process.env })

    }

    sessionTrace.delete(sessionId)
    emittedToolParts.delete(sessionId)

  }

}



async function waitForOpencodeReady(timeoutMs = 120_000) {

  const urls = [`${baseUrl}/health`, `${baseUrl}/config`, `${baseUrl}/`]

  const started = Date.now()

  while (Date.now() - started < timeoutMs) {

    for (const url of urls) {

      try {

        const res = await fetch(url, {
          headers: buildOpencodeFetchHeaders(process.env, { Accept: '*/*' }),
          signal: AbortSignal.timeout(2500),
          redirect: 'manual',
        })

        if (res.status >= 200 && res.status < 500) return true

      } catch {

        // retry

      }

    }

    await sleep(1500)

  }

  return false

}



async function connectEventStream() {
  console.log(`opencode-sse-bridge connecting ${baseUrl}/global/event`)

  const controller = new AbortController()
  const connectTimer = setTimeout(() => controller.abort(), 30_000)
  let res
  try {
    res = await fetch(`${baseUrl}/global/event`, {
      headers: buildOpencodeFetchHeaders(process.env),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(connectTimer)
  }

  if (!res.ok || !res.body) {
    throw new Error(`event_stream_failed_${res.status}`)
  }

  return res
}



async function streamEvents(res) {

  const reader = res.body.getReader()

  const decoder = new TextDecoder()

  let buffer = ''



  while (true) {

    const { done, value } = await reader.read()

    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')

    buffer = lines.pop() ?? ''

    for (const line of lines) {

      const event = parseSseLine(line)

      if (!event) continue

      await handleEvent(event)

    }

    await flush({ env: process.env })

  }

}



async function main() {

  if (!cfg.enabled) {

    console.log('kb-telemetry bridge disabled (KB_TELEMETRY_ENABLED=0)')

    return

  }



  console.log('opencode-sse-bridge waiting for OpenCode…')

  const ready = await waitForOpencodeReady()

  if (!ready) {

    console.warn('opencode-sse-bridge: OpenCode not confirmed ready, will retry connect anyway')

  }



  let attempt = 0

  while (true) {

    attempt += 1

    try {

      const res = await connectEventStream()

      console.log(`opencode-sse-bridge connected (attempt ${attempt})`)

      await streamEvents(res)

      console.warn('opencode-sse-bridge stream ended, reconnecting in 3s…')

    } catch (err) {

      console.warn(`[opencode-sse-bridge] attempt ${attempt} failed: ${err.message || err}`)

    }

    await sleep(3000)

  }

}



main().catch((err) => {

  console.error('[opencode-sse-bridge]', err.message || err)

  process.exit(1)

})


