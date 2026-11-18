import fs from 'fs'
import { readTelemetryConfig } from '../lib/config.mjs'
import { normalizeEvent } from '../lib/normalize-event.mjs'
import {
  listSpoolFiles,
  readSpoolFile,
  removeSpoolFile,
  writeSpoolFile,
} from '../lib/spool.mjs'
import {
  consumeTurnSummary,
  recordArtifactRead,
  recordContextServed,
  recordGraphQuery,
  recordOutputChars,
  recordToolCall,
} from './session.mjs'
import { graphQueryHitFields, isGraphQueryHitFromPayload } from '../lib/graph-query-hit.mjs'

const queue = []
let flushTimer = null
let flushing = false

function scheduleFlush(delayMs = 500) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, delayMs)
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

async function postBatch(endpoint, apiKey, events) {
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-KB-Telemetry-Key'] = apiKey
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`telemetry_ingest_${res.status}:${text.slice(0, 200)}`)
  }
}

function trackSessionSideEffects(event) {
  const traceId = event.session?.trace_id
  const turnId = event.session?.turn_id
  if (!traceId || !turnId) return

  if (event.event_type === 'kb.context_served') {
    recordContextServed(traceId, turnId, event.payload?.feature_id || event.feature_id)
  } else if (event.event_type === 'kb.artifact_read') {
    recordArtifactRead(traceId, turnId)
  } else if (event.event_type === 'kb.graph_query') {
    recordGraphQuery(traceId, turnId, {
      responseChars: Number(event.payload?.response_chars || 0),
      hit: isGraphQueryHitFromPayload(event.payload),
    })
  } else if (event.event_type === 'kb.tool_call') {
    recordToolCall(traceId, turnId, {
      retrieval_mode: event.payload?.retrieval_mode,
      tool_family: event.payload?.tool_family,
      hit: isGraphQueryHitFromPayload(event.payload),
    })
  }
}

export function emit(partial, options = {}) {
  const cfg = readTelemetryConfig(options.env)
  if (!cfg.enabled) return null

  const event = normalizeEvent(partial, options)
  trackSessionSideEffects(event)
  queue.push(event)
  if (queue.length >= 20) void flush(options)
  else scheduleFlush()
  return event.event_id
}

export async function flush(options = {}) {
  if (flushing || !queue.length) return { sent: 0, spooled: 0 }
  flushing = true
  const batch = queue.splice(0, queue.length)
  const cfg = readTelemetryConfig(options.env)
  let sent = 0
  let spooled = 0

  try {
    if (!cfg.endpoint) throw new Error('KB_TELEMETRY_ENDPOINT 未配置')
    await postBatch(cfg.endpoint, cfg.apiKey, batch)
    sent = batch.length
  } catch {
    writeSpoolFile(cfg.spoolDir, batch)
    spooled = batch.length
  } finally {
    flushing = false
    if (queue.length) scheduleFlush(100)
  }
  return { sent, spooled }
}

export async function replaySpool(options = {}) {
  const cfg = readTelemetryConfig(options.env)
  const files = listSpoolFiles(cfg.spoolDir)
  let replayed = 0
  for (const file of files) {
    const events = readSpoolFile(file)
    try {
      if (!cfg.endpoint) throw new Error('KB_TELEMETRY_ENDPOINT 未配置')
      await postBatch(cfg.endpoint, cfg.apiKey, events)
      removeSpoolFile(file)
      replayed += events.length
    } catch {
      break
    }
  }
  return { replayed }
}

export async function emitTurnClosed(options = {}) {
  const { traceId, turnId, status, extra, env, consumer, apiTokenId, userHash } = options
  if (!traceId || !turnId) return null
  const summary = consumeTurnSummary(traceId, turnId, { status, extra })
  if (!summary) return null
  return emit(
    {
      event_type: 'session.turn_closed',
      session: { trace_id: traceId, turn_id: turnId },
      payload: summary,
    },
    { env, consumer, apiTokenId, userHash, traceId, turnId },
  )
}

export function trackOutputChars(traceId, turnId, chars) {
  if (!traceId || !turnId || !chars) return
  recordOutputChars(traceId, turnId, chars)
}

export { createSessionContext } from './session.mjs'
export { classifyArtifactPath, classifyToolName } from '../lib/path-classifier.mjs'
export { resolveKbVersionMeta } from '../lib/kb-version.mjs'

export async function emitArtifactReadFromPath(rawPath, options = {}) {
  const { classifyArtifactPath, classifyPathBucketMeta } = await import('../lib/path-classifier.mjs')
  const { path_bucket, artifact_path } = classifyArtifactPath(rawPath, options.env)
  const bucketMeta = classifyPathBucketMeta(path_bucket)
  return emit(
    {
      event_type: 'kb.artifact_read',
      session: { trace_id: options.traceId, turn_id: options.turnId },
      payload: {
        artifact_path,
        path_bucket,
        read_bytes: options.readBytes || null,
        via: options.via || 'agent_read',
        tool_name: options.toolName || null,
        delivery: bucketMeta.delivery,
        retrieval_mode: bucketMeta.retrieval_mode,
        tool_family: bucketMeta.tool_family,
        substitute_level: bucketMeta.substitute_level,
      },
    },
    options,
  )
}

export async function emitToolCall(toolName, rawPath, options = {}) {
  const { classifyArtifactPath, classifyToolName, classifyAgentTool, classifyPathBucketMeta, canonicalAgentToolName } =
    await import('../lib/path-classifier.mjs')
  const canonicalToolName = canonicalAgentToolName(toolName)
  const agentCls = classifyAgentTool(toolName)
  const toolKind = classifyToolName(canonicalToolName)
  const { path_bucket, artifact_path } = rawPath
    ? classifyArtifactPath(rawPath, options.env)
    : { path_bucket: 'other', artifact_path: null }
  const featureId = options.featureId || options.feature_id || null

  const isCodegraph =
    agentCls.tool_family === 'codegraph' ||
    String(canonicalToolName || '').startsWith('kb_codegraph_')

  if (isCodegraph) {
    const hitPayload = graphQueryHitFields(options.toolResult, {
      tool_name: canonicalToolName,
      tool_kind: toolKind,
      tool_family: 'codegraph',
      retrieval_mode: 'codegraph_index',
      delivery: 'codegraph_mcp',
      artifact_path,
      path_bucket,
      substitute_level: 'L2',
      feature_id: featureId,
      response_chars: options.responseChars || 0,
      latency_ms: options.latencyMs || null,
    })
    return emit(
      {
        event_type: 'kb.graph_query',
        feature_id: featureId,
        session: { trace_id: options.traceId, turn_id: options.turnId },
        payload: hitPayload,
      },
      options,
    )
  }

  const eventId = emit(
    {
      event_type: 'kb.tool_call',
      feature_id: featureId,
      session: { trace_id: options.traceId, turn_id: options.turnId },
      payload: {
        tool_name: canonicalToolName,
        tool_kind: toolKind,
        tool_family: agentCls.tool_family,
        retrieval_mode: agentCls.retrieval_mode,
        delivery: agentCls.delivery,
        substitute_level: 'L3',
        artifact_path,
        path_bucket,
        feature_id: featureId,
      },
    },
    options,
  )

  if (rawPath && (path_bucket === 'harmony-kb' || path_bucket === 'harmony-docs' || path_bucket === 'android-src' || path_bucket === 'harmony-src')) {
    const bucketMeta = classifyPathBucketMeta(path_bucket)
    emit(
      {
        event_type: 'kb.artifact_read',
        feature_id: featureId,
        session: { trace_id: options.traceId, turn_id: options.turnId },
        payload: {
          artifact_path,
          path_bucket,
          via: toolKind === 'read' ? 'agent_read' : `${toolKind}_hit`,
          tool_name: canonicalToolName,
          delivery: bucketMeta.delivery,
          retrieval_mode: bucketMeta.retrieval_mode,
          tool_family: bucketMeta.tool_family,
          substitute_level: bucketMeta.substitute_level,
          feature_id: featureId,
        },
      },
      options,
    )
  }
  return eventId
}

export function isTelemetryEnabled(env = process.env) {
  return readTelemetryConfig(env).enabled
}
