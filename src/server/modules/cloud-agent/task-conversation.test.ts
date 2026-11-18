import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { TaskConversation } from './task-conversation'
import { runAnalysisInstance, type InstanceReceipt } from './runtime'

async function fixture() {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-conversation-test-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-cloud-'))
  const runDir = path.join(artifactRoot, 'harness')
  await mkdir(runDir)
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: 'native-run' }))
  const input = { taskId: 'task', workspace: { identity: 'task-workspace', artifactRoot, runDir }, role: 'execution' as const,
    model: 'model', materialVersion: 1, materialSnapshot: 'requirement', attachmentSnapshot: '[]' }
  const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }))
  const receipt = { root, pid, host: os.hostname(), sessionId: 'ses_fixture', stoppedAt: new Date().toISOString() }
  const stopped = async (session: TaskConversation) => {
    await writeFile(path.join(root, 'stopped.json'), JSON.stringify(receipt))
    await session.conversation.restore({ receipt, binding: 'model-gateway-role' })
  }
  return { input, root, receipt, stopped, async close() {
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  } }
}

test('main task resumes its stopped role session and sends only changed prompt sections plus fresh authority', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    assert.equal(first.reused, false)
    const initialPrompt = first.prompt({ mission: 'original requirement', rules: 'immutable rules' }, 'gate one')
    assert.match(initialPrompt, /original requirement/)
    assert.match(initialPrompt, /已有 Harness 账本/)
    await f.stopped(first)
    assert.equal(await first.save({ toolsSettled: true, completed: true }), true)
    // Worker attempt IDs are intentionally not part of the durable identity.
    const second = await TaskConversation.open({ ...f.input })
    assert.equal(second.reused, true)
    assert.equal(second.conversation.checkpoint()?.receipt.sessionId, 'ses_fixture')
    const delta = second.prompt({ mission: 'original requirement', rules: 'new rules' }, 'gate two')
    assert.doesNotMatch(delta, /original requirement|immutable rules|gate one/)
    assert.match(delta, /new rules/)
    assert.match(delta, /gate two/)
    assert.match(delta, /harness_status/)
  } finally { await f.close() }
})

test('task, workspace, role, model and native run changes never reuse context', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    for (const changed of [
      { ...f.input, taskId: 'other-task' },
      { ...f.input, workspace: { ...f.input.workspace, identity: 'other-workspace' } },
      { ...f.input, role: 'analysis' as const },
      { ...f.input, model: 'other-model' },
    ]) assert.equal((await TaskConversation.open(changed)).reused, false)
    await writeFile(path.join(f.input.workspace.runDir, 'manifest.json'), JSON.stringify({ run_id: 'replacement-run' }))
    assert.equal((await TaskConversation.open(f.input)).reused, false)
  } finally { await f.close() }
})

test('supplemental text, attachments and material versions reuse the session but force the current mission and authority', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'material-containing mission', rules: 'unchanged rules' }, 'old authority')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const initial = JSON.parse(await readFile(first.file, 'utf8'))
    assert.equal(initial.materialVersion, 1)
    assert.equal(initial.materialDigest, first.materialDigest)
    for (const updated of [
      { ...f.input, materialVersion: 2 },
      { ...f.input, materialSnapshot: 'supplemental text' },
      { ...f.input, attachmentSnapshot: '[{"sha256":"supplemental-image"}]' },
    ]) {
      const next = await TaskConversation.open(updated)
      assert.equal(next.reused, true)
      assert.equal(next.digest, first.digest, 'material updates cannot change the durable session binding')
      assert.equal(next.materialChanged, true)
      assert.equal(next.conversation.checkpoint()?.receipt.sessionId, 'ses_fixture')
      const delta = next.prompt({ mission: 'material-containing mission', rules: 'unchanged rules' }, 'current authority: approval pending')
      assert.match(delta, /material-containing mission/)
      assert.match(delta, /current authority: approval pending/)
      assert.match(delta, /替代旧版本材料正文与附件清单/)
      assert.match(delta, /不得从旧对话推定/)
      assert.match(delta, /harness_status/)
      assert.doesNotMatch(delta, /unchanged rules|old authority/)
    }
    const updated = { ...f.input, materialVersion: 2, materialSnapshot: 'new material text', attachmentSnapshot: '[{"id":"new-file"}]' }
    const next = await TaskConversation.open(updated)
    const delta = next.prompt({ mission: 'new material text with new-file', rules: 'unchanged rules' }, 'current authority')
    assert.match(delta, /new material text with new-file/)
    await f.stopped(next)
    await next.save({ toolsSettled: true, completed: true })
    const saved = JSON.parse(await readFile(first.file, 'utf8'))
    assert.equal(saved.materialVersion, 2)
    assert.notEqual(saved.materialDigest, initial.materialDigest)
    const same = await TaskConversation.open(updated)
    assert.equal(same.reused, true)
    assert.equal(same.materialChanged, false)
    assert.doesNotMatch(same.prompt({ mission: 'new material text with new-file', rules: 'unchanged rules' }, 'fresh gate'), /new material text with new-file|替代旧版本/)
  } finally { await f.close() }
})

test('an interrupted material update is resent until a completed settled turn acknowledges it', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'material mission' }, 'old gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const updated = { ...f.input, materialVersion: 2, materialSnapshot: 'updated material' }
    const interrupted = await TaskConversation.open(updated)
    interrupted.prompt({ mission: 'material mission' }, 'updated gate')
    await f.stopped(interrupted)
    await interrupted.save({ toolsSettled: true, completed: false })
    const saved = JSON.parse(await readFile(first.file, 'utf8'))
    assert.equal(saved.materialVersion, 1)
    assert.equal(saved.materialDigest, first.materialDigest)
    const retry = await TaskConversation.open(updated)
    assert.equal(retry.reused, true)
    assert.equal(retry.materialChanged, true)
    assert.match(retry.prompt({ mission: 'material mission' }, 'fresh gate'), /material mission/)
  } finally { await f.close() }
})

test('initial analysis binds a newly created Harness run when it safely saves', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.input.workspace.runDir, 'manifest.json'))
    const first = await TaskConversation.open({ ...f.input, role: 'analysis' })
    first.prompt({ mission: 'requirement' }, 'no manifest yet')
    await f.stopped(first)
    await writeFile(path.join(f.input.workspace.runDir, 'manifest.json'), JSON.stringify({ run_id: 'new-run' }))
    await first.save({ toolsSettled: true, completed: true })
    assert.equal((await TaskConversation.open({ ...f.input, role: 'analysis' })).reused, true)
  } finally { await f.close() }
})

test('initial analysis without a manifest asks for Harness creation, including on a reused session', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.input.workspace.runDir, 'manifest.json'))
    const input = { ...f.input, role: 'analysis' as const }
    const first = await TaskConversation.open(input)
    const prompt = first.prompt({ mission: 'locate the source entry' }, '')
    assert.match(prompt, /harness_start/)
    assert.doesNotMatch(prompt, /已有 Harness 账本|先 harness_status/)
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const resumed = await TaskConversation.open({ ...input, materialVersion: 2, materialSnapshot: 'updated requirement' })
    assert.equal(resumed.reused, true)
    assert.equal(resumed.materialChanged, true)
    const retryPrompt = resumed.prompt({ mission: 'locate the source entry' }, '')
    assert.match(retryPrompt, /harness_start/)
    assert.doesNotMatch(retryPrompt, /已有 Harness 账本|先 harness_status/)
  } finally { await f.close() }
})

test('unsettled tools or an unavailable runtime never overwrite a valid checkpoint', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const before = await readFile(first.file, 'utf8')
    const next = await TaskConversation.open(f.input)
    next.prompt({ mission: 'changed rules' }, 'new gate')
    assert.equal(await next.save({ toolsSettled: false, completed: true }), false)
    assert.equal(await readFile(first.file, 'utf8'), before)
    next.conversation.reset()
    assert.equal(await next.save({ toolsSettled: true, completed: false }), false)
    assert.equal(await readFile(first.file, 'utf8'), before)
  } finally { await f.close() }
})

test('safely stopped failures retain session history but do not mark new prompt sections delivered', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement', rules: 'old rules' }, 'old gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const failed = await TaskConversation.open(f.input)
    failed.prompt({ mission: 'requirement', rules: 'new rules' }, 'failed gate')
    await f.stopped(failed)
    await failed.save({ toolsSettled: true, completed: false })
    const next = await TaskConversation.open(f.input)
    assert.equal(next.reused, true)
    assert.match(next.prompt({ mission: 'requirement', rules: 'new rules' }, 'current gate'), /new rules/)
  } finally { await f.close() }
})

test('a later stopped turn keeps the same session reusable when its task checkpoint was not published', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const later = { ...f.receipt, pid: Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })),
      startedAt: new Date(Date.parse(f.receipt.stoppedAt) + 1000).toISOString(),
      stoppedAt: new Date(Date.parse(f.receipt.stoppedAt) + 2000).toISOString() }
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify(later))
    const resumed = await TaskConversation.open(f.input)
    assert.equal(resumed.reused, true)
    assert.deepEqual(resumed.conversation.checkpoint()?.receipt, later)
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify({ ...later, pid: process.pid }))
    await assert.rejects(TaskConversation.open(f.input), /旧进程仍存在/)
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify({ ...later, sessionId: 'ses_other' }))
    await assert.rejects(TaskConversation.open(f.input), /停止收据/)
  } finally { await f.close() }
})

test('a live prior process, inconsistent stop receipt or invalid prompt hash is rejected', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const saved = JSON.parse(await readFile(first.file, 'utf8'))
    const live = { ...saved, conversation: { ...saved.conversation, receipt: { ...f.receipt, pid: process.pid } } }
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify(live.conversation.receipt))
    await writeFile(first.file, JSON.stringify(live))
    await assert.rejects(TaskConversation.open(f.input), /旧进程仍存在/)
    await assert.rejects(TaskConversation.open({ ...f.input, materialVersion: 2, materialSnapshot: 'supplement' }), /旧进程仍存在/)
    await writeFile(first.file, JSON.stringify(saved))
    await assert.rejects(TaskConversation.open(f.input), /停止收据/)
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify(f.receipt))
    await writeFile(first.file, JSON.stringify({ ...saved, promptHashes: { mission: 'not-a-sha' } }))
    await assert.rejects(TaskConversation.open(f.input), /提示词检查点/)
    await writeFile(first.file, JSON.stringify({ ...saved, materialDigest: 'not-a-sha' }))
    await assert.rejects(TaskConversation.open(f.input), /材料检查点/)
  } finally { await f.close() }
})

test('checkpoint publication rechecks the process, native run, and concurrent checkpoint changes', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const next = await TaskConversation.open(f.input)
    const before = await readFile(first.file, 'utf8')
    await writeFile(path.join(f.root, 'stopped.json'), JSON.stringify({ ...f.receipt, pid: process.pid }))
    await assert.rejects(next.save({ toolsSettled: true, completed: true }), /停止收据/)
    assert.equal(await readFile(first.file, 'utf8'), before)
    await f.stopped(next)
    await writeFile(path.join(f.input.workspace.runDir, 'manifest.json'), JSON.stringify({ run_id: 'changed-during-execution' }))
    await assert.rejects(next.save({ toolsSettled: true, completed: true }), /运行身份在执行中变化/)
    assert.equal(await readFile(first.file, 'utf8'), before)
    await writeFile(path.join(f.input.workspace.runDir, 'manifest.json'), JSON.stringify({ run_id: 'native-run' }))
    await writeFile(first.file, before + '\n')
    await assert.rejects(next.save({ toolsSettled: true, completed: true }), /其他执行更新/)
    assert.equal(await readFile(first.file, 'utf8'), before + '\n')
  } finally { await f.close() }
})

test('removed prompt sections are explicitly withdrawn and empty text changes are not dropped', async () => {
  const f = await fixture()
  try {
    const first = await TaskConversation.open(f.input)
    first.prompt({ mission: 'requirement', removed: 'no longer relevant' }, 'gate')
    await f.stopped(first)
    await first.save({ toolsSettled: true, completed: true })
    const next = await TaskConversation.open(f.input)
    const delta = next.prompt({ mission: '' }, 'current gate')
    assert.match(delta, /name="mission"/)
    assert.match(delta, /已移除的上下文片段=\["removed"\]/)
    assert.doesNotMatch(delta, /no longer relevant/)
  } finally { await f.close() }
})

test('runtime keeps the actual session across errors and material updates, isolates gateways, and uses packet-based device guidance', async context => {
  const f = await fixture()
  const runtimeRoots = new Set<string>()
  const environment = ['SUB2API_API_KEY', 'CLOUD_AGENT_MODEL_BASE_URL', 'OPENCODE_BIN'] as const
  const original = Object.fromEntries(environment.map(key => [key, process.env[key]]))
  process.env.SUB2API_API_KEY = 'synthetic-key-not-used-for-network'
  process.env.CLOUD_AGENT_MODEL_BASE_URL = 'https://synthetic.invalid/v1'
  process.env.OPENCODE_BIN = process.execPath
  let activeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: null }
  let configFile = '', createdSessions = 0, starts = 0, turn = 0, fail = false
  let lastReceipt: InstanceReceipt | undefined
  const prompts: string[] = []
  context.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: SpawnOptions) => {
    starts++
    configFile = String(options.env!.OPENCODE_CONFIG)
    activeChild = Object.assign(new EventEmitter(), { pid: f.receipt.pid, exitCode: null as number | null, signalCode: null })
    return activeChild as ChildProcess
  })
  syncBuiltinESMExports()
  context.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    assert.equal(url.hostname, '127.0.0.1', 'the test must not contact a model gateway')
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/global/health') return json({ version: 'synthetic' })
    if (url.pathname === '/config') return json(JSON.parse(await readFile(configFile, 'utf8')))
    if (url.pathname === '/session' && init?.method === 'POST') { createdSessions++; return json({ id: 'ses_mainfixture' }) }
    if (url.pathname === '/session/ses_mainfixture') return json({ id: 'ses_mainfixture' })
    if (url.pathname.endsWith('/abort')) { activeChild.exitCode = 0; return json(null) }
    if (url.pathname.endsWith('/prompt_async')) {
      prompts.push(JSON.parse(String(init?.body)).parts[0].text)
      turn++
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/message')) return json([{ info: { id: `turn-${turn}`, role: 'assistant', time: { completed: 123 },
      finish: 'stop', ...(fail ? { error: { name: 'SyntheticGatewayError' } } : {}) }, parts: [{ type: 'text', text: 'synthetic result' }] }])
    throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`)
  })
  const execute = (session: TaskConversation, rules: string, mission = 'original material') => runAnalysisInstance({ model: f.input.model,
    prompt: session.prompt({ mission, rules }, 'verified current gate'), execution: true,
    conversation: session.conversation, retainStoppedConversation: true, signal: new AbortController().signal,
    onInstance: async receipt => { lastReceipt = receipt; runtimeRoots.add(receipt.root) }, onProgress: async () => {} })
  try {
    const first = await TaskConversation.open(f.input)
    assert.equal(await execute(first, 'old rules'), 'synthetic result')
    assert.equal(first.conversation.reusable, true)
    assert.ok(lastReceipt?.stoppedAt)
    await first.save({ toolsSettled: true, completed: true })
    const failed = await TaskConversation.open(f.input)
    fail = true
    await assert.rejects(execute(failed, 'new rules'), /模型返回错误/)
    assert.equal(failed.conversation.reusable, true, 'stopped history is only a candidate until tools settle')
    assert.doesNotMatch(prompts[1], /original material/)
    const previousCheckpoint = await readFile(first.file, 'utf8')
    assert.equal(await failed.save({ toolsSettled: false, completed: false }), false)
    assert.equal(await readFile(first.file, 'utf8'), previousCheckpoint)
    await failed.save({ toolsSettled: true, completed: false })
    const resumed = await TaskConversation.open(f.input)
    fail = false
    assert.equal(await execute(resumed, 'new rules'), 'synthetic result')
    assert.equal(createdSessions, 1)
    assert.equal(runtimeRoots.size, 1)
    assert.equal(starts, 3, 'the process can restart without recreating the conversation')
    assert.match(prompts[2], /new rules/)
    assert.doesNotMatch(prompts[2], /original material/)
    await resumed.save({ toolsSettled: true, completed: true })
    const updated = { ...f.input, materialVersion: 2, materialSnapshot: 'supplemental material', attachmentSnapshot: '[{"id":"new-recording"}]' }
    const supplemental = await TaskConversation.open(updated)
    assert.equal(await execute(supplemental, 'new rules', 'supplemental material and new-recording'), 'synthetic result')
    assert.equal(createdSessions, 1, 'supplemental materials do not recreate the OpenCode session')
    assert.equal(runtimeRoots.size, 1)
    assert.equal(starts, 4)
    assert.match(prompts[3], /supplemental material and new-recording/)
    assert.match(prompts[3], /替代旧版本材料正文与附件清单/)
    assert.doesNotMatch(prompts[3], /original material/)
    await supplemental.save({ toolsSettled: true, completed: true })
    const mismatch = await TaskConversation.open(updated)
    process.env.CLOUD_AGENT_MODEL_BASE_URL = 'https://other-synthetic.invalid/v1'
    await assert.rejects(execute(mismatch, 'new rules'), /网关配置变化/)
    assert.equal(starts, 4, 'binding failure must occur before starting another process')
    await runAnalysisInstance({ model: f.input.model, deviceReview: true, prompt: 'synthetic device review', signal: new AbortController().signal,
      onInstance: async receipt => { runtimeRoots.add(receipt.root) }, onProgress: async () => {} })
    const deviceConfig = JSON.parse(await readFile(configFile, 'utf8'))
    assert.match(deviceConfig.agent['cloud-analysis'].prompt, /逐用例证据包和必读图片/)
    assert.match(deviceConfig.agent['cloud-analysis'].prompt, /必读文本必须分页读到 nextOffset=null/)
    assert.match(deviceConfig.agent['cloud-analysis'].prompt, /原始控件树和收据按需展开/)
    assert.equal(deviceConfig.permission['*'], 'deny')
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    for (const key of environment) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    for (const root of runtimeRoots) await rm(root, { recursive: true, force: true })
    await f.close()
  }
})
