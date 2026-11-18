#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { streamChat } from '../src/lib/opencode/opencode-client.ts'
import { createTranslatorState, translateEvent } from '../src/lib/opencode/opencode-events.ts'

async function startFixture(mode) {
  let eventResponse = null
  let abortCount = 0
  let releaseFinal = () => {}
  const sessionId = `ses_${mode.replaceAll('-', '_')}_test`
  const send = (event) => eventResponse?.write(`data: ${JSON.stringify(event)}\n\n`)
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: sessionId }))
      return
    }
    if (req.method === 'GET' && req.url === '/global/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      res.write(': connected\n\n')
      eventResponse = res
      return
    }
    if (req.method === 'POST' && req.url === `/session/${sessionId}/prompt_async`) {
      res.writeHead(204)
      res.end()
      if (mode === 'upstream') {
        const event = {
          type: 'session.error',
          properties: {
            sessionID: sessionId,
            error: { type: 'upstream_error', code: 'stream_read_error', message: 'stream_read_error' },
          },
        }
        send(event)
      } else if (mode === 'tool-flow') {
        send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-tool', sessionID: sessionId, role: 'assistant' },
          },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'tool-text', messageID: 'assistant-tool', sessionID: sessionId, type: 'text', text: '' },
          },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'reasoning', messageID: 'assistant-tool', sessionID: sessionId, type: 'reasoning', text: '' },
          },
        })
        send({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'reasoning', field: 'text', delta: '正在分析资料入口。' },
        })
        send({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'tool-text', field: 'text', delta: '我先读取源码。' },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'tool-call', messageID: 'assistant-tool', sessionID: sessionId, type: 'tool' },
          },
        })
        send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-tool', sessionID: sessionId, role: 'assistant', finish: 'tool-calls' },
          },
        })
        send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-final', sessionID: sessionId, role: 'assistant' },
          },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'final-text', messageID: 'assistant-final', sessionID: sessionId, type: 'text', text: '' },
          },
        })
        send({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'final-text', field: 'text', delta: '这是完整最终答案。' },
        })
        releaseFinal = () => send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-final', sessionID: sessionId, role: 'assistant', finish: 'stop' },
          },
        })
      } else if (mode === 'timeout-draft') {
        send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-draft', sessionID: sessionId, role: 'assistant' },
          },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'draft-text', messageID: 'assistant-draft', sessionID: sessionId, type: 'text', text: '' },
          },
        })
        send({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'draft-text', field: 'text', delta: '已生成但尚未完整的答案。' },
        })
      } else if (mode === 'eof-draft') {
        send({
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-eof', sessionID: sessionId, role: 'assistant' },
          },
        })
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'eof-text', messageID: 'assistant-eof', sessionID: sessionId, type: 'text', text: '' },
          },
        })
        send({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'eof-text', field: 'text', delta: '连接关闭前的有效草稿。' },
        })
        eventResponse?.end()
      }
      return
    }
    if (req.method === 'POST' && req.url === `/session/${sessionId}/abort`) {
      abortCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('true')
      eventResponse?.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    cfg: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: mode === 'timeout' || mode === 'timeout-draft' ? 80 : 1000,
      username: 'opencode',
      password: 'test-password',
    },
    abortCount: () => abortCount,
    releaseFinal: () => releaseFinal(),
    close: async () => {
      eventResponse?.end()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function collectEvents(cfg) {
  const events = []
  for await (const event of streamChat({ message: 'test', sessionId: null, cfg })) {
    events.push(event)
  }
  return events
}

const timeoutFixture = await startFixture('timeout')
try {
  const startedAt = Date.now()
  const events = await collectEvents(timeoutFixture.cfg)
  assert.ok(Date.now() - startedAt < 1000, 'chat stream must honor cfg.timeoutMs')
  assert.equal(events[0]?.type, 'session')
  assert.deepEqual(events.at(-1), { type: 'error', message: 'opencode_response_timeout' })
  assert.equal(timeoutFixture.abortCount(), 1, 'timeout must abort the remote OpenCode session')
} finally {
  await timeoutFixture.close()
}

const upstreamFixture = await startFixture('upstream')
try {
  const events = await collectEvents(upstreamFixture.cfg)
  assert.equal(events[0]?.type, 'session')
  assert.deepEqual(events.at(-1), {
    type: 'error',
    message: 'opencode_upstream_stream_interrupted',
  })
} finally {
  await upstreamFixture.close()
}

const toolFlowFixture = await startFixture('tool-flow')
try {
  const events = []
  for await (const event of streamChat({ message: 'test', sessionId: null, cfg: toolFlowFixture.cfg })) {
    events.push(event)
    // The server withholds completion until the final text is observed by the consumer.
    if (event.type === 'token' && event.text === '这是完整最终答案。') toolFlowFixture.releaseFinal()
  }
  assert.deepEqual(events, [
    { type: 'session', sessionId: 'ses_tool_flow_test' },
    { type: 'reasoning', text: '正在分析资料入口。' },
    { type: 'token', text: '我先读取源码。' },
    { type: 'token', text: '这是完整最终答案。' },
    { type: 'done' },
  ])
} finally {
  await toolFlowFixture.close()
}

const timeoutDraftFixture = await startFixture('timeout-draft')
try {
  const events = await collectEvents(timeoutDraftFixture.cfg)
  assert.deepEqual(events.slice(-2), [
    { type: 'token', text: '已生成但尚未完整的答案。' },
    { type: 'error', message: 'opencode_response_timeout' },
  ])
  assert.equal(timeoutDraftFixture.abortCount(), 1)
} finally {
  await timeoutDraftFixture.close()
}

const eofDraftFixture = await startFixture('eof-draft')
try {
  const events = await collectEvents(eofDraftFixture.cfg)
  assert.deepEqual(events.slice(-2), [
    { type: 'token', text: '连接关闭前的有效草稿。' },
    { type: 'error', message: 'opencode_upstream_stream_interrupted' },
  ])
  assert.equal(eofDraftFixture.abortCount(), 1)
} finally {
  await eofDraftFixture.close()
}

let state = createTranslatorState('ses_incremental')
function translate(type, properties) {
  const result = translateEvent(state, { type, properties })
  state = result.state
  return result.emit
}
translate('message.updated', { info: { id: 'user', sessionID: state.sessionId, role: 'user' } })
assert.deepEqual(translate('message.part.updated', {
  part: { id: 'user-part', messageID: 'user', sessionID: state.sessionId, type: 'text', text: '不能回显的用户提示词' },
}), [])
translate('message.updated', { info: { id: 'assistant', sessionID: state.sessionId, role: 'assistant' } })
const textPart = { id: 'answer', messageID: 'assistant', sessionID: state.sessionId, type: 'text' }
assert.deepEqual(translate('message.part.updated', { part: { ...textPart, text: '第一段' } }), [{ type: 'token', text: '第一段' }])
assert.deepEqual(translate('message.part.delta', { sessionID: state.sessionId, partID: 'answer', field: 'text', delta: '第二段' }), [{ type: 'token', text: '第二段' }])
assert.deepEqual(translate('message.part.updated', { part: { ...textPart, text: '第一段第二段' } }), [])
assert.deepEqual(translate('message.part.delta', { sessionID: 'ses_other', partID: 'answer', field: 'text', delta: '其他会话' }), [])
assert.deepEqual(translate('session.error', { sessionID: state.sessionId, error: { message: 'stream_read_error' } }), [{ type: 'error', message: 'opencode_upstream_stream_interrupted' }])

console.log('test-opencode-stream: ok')
