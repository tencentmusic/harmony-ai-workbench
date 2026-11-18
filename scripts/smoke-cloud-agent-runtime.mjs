import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { runAnalysisInstance, RuntimeConversation } from '../src/server/modules/cloud-agent/runtime.ts'
import { startTaskTools, taskTool } from '../src/server/modules/cloud-agent/task-tools.ts'
import { ExecutionContinuation } from '../src/server/modules/cloud-agent/execution-continuation.ts'
import { HARNESS_PHASES } from '../src/contracts/cloud-agent.ts'
import { mutateSource } from '../src/server/modules/cloud-agent/source-files.ts'
import { sha256 } from '../src/server/modules/cloud-agent/scoped-files.ts'

// Real OpenCode processes and HTTP protocol; deterministic local model fixture, no paid call.
const output = JSON.stringify({ summary: 'smoke', requirements: ['fixture'], approach: ['readonly'], acceptance: ['assert'], questions: [] })
let requests = 0
let toolMode = false
let toolExecuted = false
let emptyResponse = false
let sourceEditCall = null
const imageData = (await sharp({ create: { width: 32, height: 32, channels: 3, background: '#27a395' } }).png().toBuffer()).toString('base64')
const pdfData = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64')
const payloads = []
const gateway = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  assert.equal(body.model, 'gpt-6-sol')
  requests++
  payloads.push(JSON.stringify(body))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
  if (emptyResponse) {
    if (req.url?.endsWith('/chat/completions')) {
      emit({ id: 'chatcmpl_empty', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.end('data: [DONE]\n\n')
    } else {
      emit({ type: 'response.created', response: { id: 'resp_empty', status: 'in_progress', output: [] } })
      emit({ type: 'response.completed', response: { id: 'resp_empty', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })
      res.end()
    }
    return
  }
  if (toolMode && !toolExecuted || sourceEditCall) {
    const toolName = sourceEditCall ? 'task_source_edit' : 'task_probe'
    const toolArgs = sourceEditCall ? JSON.stringify(sourceEditCall) : '{}'
    sourceEditCall = null
    const available = (body.tools || []).map(tool => tool.name || tool.function?.name)
    assert.ok(available.includes(toolName), `task tool not exposed: ${available}`)
    if (req.url?.endsWith('/chat/completions')) {
      emit({ id: 'chatcmpl_tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: toolName, arguments: toolArgs } }] }, finish_reason: null }] })
      emit({ id: 'chatcmpl_tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.end('data: [DONE]\n\n')
    } else {
      const item = { id: 'fc_probe', type: 'function_call', call_id: 'call_probe', name: toolName, arguments: toolArgs, status: 'completed' }
      emit({ type: 'response.created', response: { id: 'resp_tool', status: 'in_progress', output: [] } })
      emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
      emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: toolArgs })
      emit({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: toolArgs })
      emit({ type: 'response.output_item.done', output_index: 0, item })
      emit({ type: 'response.completed', response: { id: 'resp_tool', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
      res.end()
    }
    return
  }
  if (req.url?.endsWith('/chat/completions')) {
    emit({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })
    emit({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.end('data: [DONE]\n\n')
  } else {
    const item = { id: 'msg_smoke', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output, annotations: [] }] }
    const response = { id: 'resp_smoke', object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 30, total_tokens: 40, output_tokens_details: { reasoning_tokens: 0 } } }
    emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: output })
    emit({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: output })
    emit({ type: 'response.output_item.done', output_index: 0, item })
    emit({ type: 'response.completed', response })
    res.end()
  }
})
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
process.env.CLOUD_AGENT_MODEL_BASE_URL = `http://127.0.0.1:${gateway.address().port}/v1`
process.env.SUB2API_API_KEY = 'local-smoke-fixture-not-a-secret'
const receipts = []
try {
  await Promise.all(Array.from({ length: 2 }, async () => {
    let progress = ''
    let receipt
    const actual = await runAnalysisInstance({ model: 'gpt-6-sol', prompt: 'Return the test JSON. Do not use tools.', files: [
      { type: 'file', mime: 'image/png', filename: 'screen.png', url: `data:image/png;base64,${imageData}` },
      { type: 'file', mime: 'application/pdf', filename: 'requirements.pdf', url: `data:application/pdf;base64,${pdfData}` },
    ], signal: AbortSignal.timeout(55000), onInstance: async value => { receipt = value }, onProgress: async value => { progress = value } })
    assert.equal(actual, output)
    assert.equal(progress, output)
    assert.ok(receipt.stoppedAt)
    assert.equal(JSON.parse(await readFile(path.join(receipt.root, 'stopped.json'), 'utf8')).pid, receipt.pid)
    assert.equal((await fetch(`http://127.0.0.1:${receipt.port}/global/health`).catch(() => null)), null)
    receipts.push(receipt)
  }))
  assert.notEqual(receipts[0].pid, receipts[1].pid)
  assert.notEqual(receipts[0].root, receipts[1].root)
  assert.notEqual(receipts[0].sessionId, receipts[1].sessionId)
  assert.equal(requests, 2)
  assert.ok(payloads.every(body => body.includes(imageData) && body.includes(pdfData)), 'image and PDF bytes must actually reach the gateway')
  const cancellation = new AbortController()
  let cancelledReceipt
  await assert.rejects(runAnalysisInstance({ model: 'gpt-6-sol', prompt: 'Never submitted', signal: cancellation.signal,
    onInstance: async value => { cancelledReceipt = value; if (value.sessionId) cancellation.abort() }, onProgress: async () => {},
  }), /abort/i)
  assert.ok(cancelledReceipt.stoppedAt)
  assert.equal(requests, 2)
  const longToolMs = process.argv.includes('--long-tool') ? 270000 : 0
  const toolSignal = AbortSignal.timeout(longToolMs + 55000)
  const taskEndpoint = await startTaskTools([taskTool('probe', 'Fixture image and document reader', {}, [], async () => {
    toolExecuted = true
    if (longToolMs) {
      console.log('Real OpenCode: holding tool for 270 seconds to cross the observed idle timeout')
      await new Promise(resolve => setTimeout(resolve, longToolMs))
    }
    return { content: [{ type: 'text', text: 'Task material evidence' }, { type: 'image', mimeType: 'image/png', data: imageData }, { type: 'resource', resource: { uri: 'file:///fixture.pdf', mimeType: 'application/pdf', blob: pdfData } }] }
  })], toolSignal, async () => {}, longToolMs + 180000)
  try {
    toolMode = true
    const answer = await runAnalysisInstance({ model: 'gpt-6-sol', prompt: 'Call task_probe then return the JSON.', signal: toolSignal, taskMcp: taskEndpoint.config, onInstance: async () => {}, onProgress: async () => {} })
    assert.equal(answer, output)
    assert.equal(toolExecuted, true)
    assert.equal(requests, 4, 'runtime must continue after a tool-call message completes')
    assert.ok(payloads.at(-1).includes(imageData), 'MCP image must reach model on the next turn')
    assert.ok(payloads.at(-1).includes(pdfData), 'MCP PDF must reach model on the next turn')
    if (longToolMs) console.log('PASS: 270-second MCP call returned evidence to real OpenCode without idle timeout')
  } finally { toolMode = false; await taskEndpoint.close() }
  let checkpoints = 0
  const sessionIds = new Set(), processIds = new Set()
  let continuedReceipt
  const continued = await runAnalysisInstance({ model: 'gpt-6-sol', prompt: 'Return fixture JSON.', signal: AbortSignal.timeout(55000),
    onInstance: async value => { continuedReceipt = value; processIds.add(value.pid); if (value.sessionId) sessionIds.add(value.sessionId) },
    onProgress: async () => {},
    onTurnComplete: async () => { checkpoints++; return checkpoints === 1 ? 'Continue the same task; return fixture JSON again.' : null },
  })
  assert.equal(continued, output)
  assert.equal(checkpoints, 2, 'completed message must not be processed twice while waiting for follow-up')
  assert.equal(requests, 6, 'final text requires a second model turn when the task checkpoint requests continuation')
  assert.equal(sessionIds.size, 1)
  assert.equal(processIds.size, 1)
  assert.ok(continuedReceipt.stoppedAt)
  // A model that only returns final prose must be driven until a verified checkpoint or guard stops it.
  for (const scenario of ['human-review', 'no-progress']) {
    const policy = new ExecutionContinuation(), decisions = [], executionSessions = new Set(), executionProcesses = new Set()
    let turn = 0, executionReceipt
    const previousRequests = requests
    await runAnalysisInstance({ model: 'gpt-6-sol', execution: true, prompt: 'Return the fixture JSON.', signal: AbortSignal.timeout(90000),
      onInstance: async value => { executionReceipt = value; executionProcesses.add(value.pid); if (value.sessionId) executionSessions.add(value.sessionId) },
      onProgress: async () => {},
      onTurnComplete: async () => {
        const phase = scenario === 'human-review' ? ['ui_prototype_approved', 'implemented', 'wired', 'build_passed'][turn] : 'ui_prototype_approved'
        const snapshot = { phase, checkedAt: String(turn), branch: '', worktree: '', runDir: '', blockers: [], next: [], reviewPackage: '',
          nodes: HARNESS_PHASES.map(([id, label], index) => ({ id, label, status: index <= HARNESS_PHASES.findIndex(([p]) => p === phase) ? 'passed' : 'pending' })),
          codeReview: { status: 'passed', summary: '', checks: [], findings: [] } }
        const decision = policy.decide({ status: snapshot, progress: 0, review: scenario === 'human-review' && turn === 3 ? 'visual' : undefined })
        decisions.push(decision.kind); turn++
        return decision.kind === 'continue' ? decision.prompt : null
      },
    })
    assert.deepEqual(decisions, ['continue', 'continue', 'continue', scenario === 'human-review' ? 'approval' : 'blocked'])
    assert.equal(requests - previousRequests, 4)
    assert.equal(executionSessions.size, 1); assert.equal(executionProcesses.size, 1)
    assert.ok(executionReceipt.stoppedAt)
  }
  emptyResponse = true
  const emptySessions = new Set(), notices = []
  let emptyTurns = 0
  const emptyRecovered = await runAnalysisInstance({ model: 'gpt-6-sol', execution: true, prompt: 'Return fixture JSON.', signal: AbortSignal.timeout(55000),
    onInstance: async value => { if (value.sessionId) emptySessions.add(value.sessionId) }, onProgress: async () => {}, onNotice: async value => { notices.push(value) },
    onTurnComplete: async text => { emptyTurns++; if (emptyTurns === 1) { assert.equal(text, ''); emptyResponse = false; return 'Continue the current task; return fixture JSON.' }; return null },
  })
  assert.equal(emptyRecovered, output); assert.equal(emptyTurns, 2); assert.equal(emptySessions.size, 1); assert.equal(notices.length, 1)
  emptyResponse = true
  await assert.rejects(runAnalysisInstance({ model: 'gpt-6-sol', prompt: 'Return fixture.', signal: AbortSignal.timeout(55000), onInstance: async () => {}, onProgress: async () => {} }), /返回空结果/)
  emptyResponse = false
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'cloud-opencode-edit-'))
  const original = '\ufeff' + '// retained line\r\n'.repeat(20000) + 'oldCall();\r\n'
  const editEvents = []
  const sourceSignal = AbortSignal.timeout(55000)
  const sourceEndpoint = await startTaskTools([taskTool('source_edit', 'Edit a unique text fragment in the task project', {
    path: { type: 'string' }, expectedSha256: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } },
  }, ['path', 'expectedSha256', 'edits'], async args => ({ content: [{ type: 'text', text: JSON.stringify(await mutateSource(sourceRoot, { ...args, operation: 'edit' })) }] }))], sourceSignal, async event => { editEvents.push(event) })
  try {
    await writeFile(path.join(sourceRoot, 'Main.ets'), original)
    sourceEditCall = { path: 'Main.ets', expectedSha256: sha256(original), edits: [{ oldText: 'oldCall()', newText: 'newCall()' }] }
    const result = await runAnalysisInstance({ model: 'gpt-6-sol', execution: true, prompt: 'Use task_source_edit then report.', signal: sourceSignal, taskMcp: sourceEndpoint.config, onInstance: async () => {}, onProgress: async () => {} })
    assert.equal(result, output)
    assert.equal(await readFile(path.join(sourceRoot, 'Main.ets'), 'utf8'), original.replace('oldCall()', 'newCall()'))
    assert.ok(editEvents.includes('完成 source_edit'))
    console.log('PASS: real OpenCode source_edit changes large file without whole-file replacement')
  } finally { await sourceEndpoint.close(); await rm(sourceRoot, { recursive: true, force: true }) }
  const conversation = new RuntimeConversation(), reviewReceipts = []
  const previousRequests = requests
  const reviewToolCalls = []
  for (const prompt of ['Remember REVIEW_CONTEXT_7531 and return JSON.', 'Review only the changed file; return JSON.']) {
    let receipt
    const reviewSignal = AbortSignal.timeout(55000)
    const reviewEndpoint = await startTaskTools([taskTool('probe', 'Read current review evidence', {}, [], async () => {
      toolExecuted = true; reviewToolCalls.push(prompt)
      return { content: [{ type: 'text', text: 'Current review evidence' }] }
    })], reviewSignal, async () => {})
    try {
      toolMode = true; toolExecuted = false
      const value = await runAnalysisInstance({ model: 'gpt-6-sol', codeReview: true, conversation, prompt, signal: reviewSignal, taskMcp: reviewEndpoint.config,
        onInstance: async item => { receipt = item }, onProgress: async () => {} })
      assert.equal(value, output); assert.ok(conversation.reusable); assert.ok(receipt.stoppedAt)
    } finally { toolMode = false; await reviewEndpoint.close() }
    reviewReceipts.push(receipt)
  }
  assert.equal(requests - previousRequests, 4, 'each invocation must read fresh MCP evidence before completing')
  assert.equal(reviewToolCalls.length, 2, 'resumed process must use the new authenticated MCP endpoint')
  assert.equal(reviewReceipts[0].root, reviewReceipts[1].root)
  assert.equal(reviewReceipts[0].sessionId, reviewReceipts[1].sessionId)
  assert.notEqual(reviewReceipts[0].pid, reviewReceipts[1].pid)
  assert.ok(payloads.at(-1).includes('REVIEW_CONTEXT_7531'), 'OpenCode must retain first-review context after process shutdown')
  await assert.rejects(runAnalysisInstance({ model: 'different', codeReview: true, conversation, prompt: 'Invalid reuse', signal: AbortSignal.timeout(55000), onInstance: async () => {}, onProgress: async () => {} }), /配置变化/)
  assert.equal(conversation.reusable, false)
  console.log('PASS: independent reviewer reuses session/history across calls and rejects role/model rebinding')
  console.log(JSON.stringify({ passed: true, concurrentProcesses: receipts.length, model: 'local fixture', openCodeVersion: receipts[0].version, checks: ['effective scoped tool config', 'isolated home/cwd/session', 'image/PDF payload reaches gateway', 'MCP image/PDF tool outputs', 'tool-call continuation', 'same-session task continuation after final text', 'execution approval and no-progress guards', 'empty final response resumes same session', 'empty unmanaged result fails immediately', 'async prompt', 'incremental output', 'owned process shutdown', 'cancel before prompt'] }))
} finally { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
