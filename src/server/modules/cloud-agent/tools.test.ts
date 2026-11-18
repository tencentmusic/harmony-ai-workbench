import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { materialTools } from './material-tools'
import { scopedPath, sha256, writeScoped } from './scoped-files'
import { startTaskTools, taskTool, textResult } from './task-tools'
import { taskWorktree } from './worktrees'
import { handshakeHarness, executionTools, verifyHarness, type HarnessWorkspace } from './harness'
import { CloudRecoveryError } from './domain'

test('draining refuses new calls and waits for the native operation to settle', async () => {
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const endpoint = await startTaskTools([taskTool('write', 'fixture', {}, [], async () => { started(); await gate; return textResult('saved') })], new AbortController().signal, async () => {})
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    const call = client.callTool({ name: 'write' })
    await ready
    assert.equal(await endpoint.drain(0), false)
    release()
    assert.equal((await call).isError, undefined)
    assert.equal(await endpoint.drain(1000), true)
    assert.equal((await client.callTool({ name: 'write' })).isError, true)
  } finally { release(); await client.close(); await endpoint.close() }
})

test('uncertain tool termination blocks later calls until operator recovery', async () => {
  const endpoint = await startTaskTools([taskTool('uncertain', 'fixture', {}, [], async () => { throw new CloudRecoveryError('synthetic timeout', 409) })], new AbortController().signal, async () => {})
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    assert.equal((await client.callTool({ name: 'uncertain' })).isError, true)
    assert.equal(endpoint.recovery(), true)
    const result = await client.callTool({ name: 'uncertain' })
    assert.match(JSON.stringify(result.content), /运维恢复/)
  } finally { await client.close(); await endpoint.close() }
})

test('task MCP authentication, schema discovery and revocable tools', async () => {
  const abort = new AbortController()
  const endpoint = await startTaskTools([taskTool('probe', 'fixture', {}, [], async () => textResult('ok'))], abort.signal, async () => {})
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    assert.equal((await fetch(endpoint.config.url, { method: 'POST', body: '{}' })).status, 403)
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    assert.equal((await client.listTools()).tools[0].name, 'probe')
    assert.deepEqual((await client.callTool({ name: 'probe' })).content, [{ type: 'text', text: 'ok' }])
    abort.abort()
    await assert.rejects(client.callTool({ name: 'probe' }))
  } finally { await client.close(); await endpoint.close() }
})

test('tool budget exhaustion is visible to the continuation controller', async () => {
  let calls = 0
  const endpoint = await startTaskTools([taskTool('probe', 'fixture', {}, [], async () => { calls++; return textResult('ok') })], new AbortController().signal, async () => {})
  const client = new Client({ name: 'budget-test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    assert.equal(endpoint.exhausted(), false)
    for (let i = 0; i < 400; i++) assert.ok(!(await client.callTool({ name: 'probe' })).isError)
    assert.equal(endpoint.exhausted(), true)
    assert.equal((await client.callTool({ name: 'probe' })).isError, true)
    assert.equal(calls, 400)
  } finally { await client.close(); await endpoint.close() }
})

test('material frames are agent-selected, allow more than six and reject cross-task paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-frames-'))
  const id = randomUUID(), folder = path.join(root, id)
  const original = process.env.CLOUD_AGENT_MATERIAL_ROOT
  process.env.CLOUD_AGENT_MATERIAL_ROOT = root
  try {
    await mkdir(folder)
    const file = path.join(folder, 'original')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=100x100:rate=4', '-t', '3', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-y', file], { windowsHide: true })
    const bytes = await readFile(file)
    const { tools } = await materialTools([{ id, name: 'flow.mp4', kind: 'video', mime: 'video/mp4', size: bytes.length, sha256: sha256(bytes) }], new AbortController().signal, path.join(root, 'output'))
    const read = tools.find(tool => tool.definition.name === 'read_material')!
    const frames = tools.find(tool => tool.definition.name === 'video_frames')!
    await assert.rejects(read.call({ id: randomUUID() }), /本轮/)
    await assert.rejects(frames.call({ id, timestamps: [3], reason: 'out of range' }), /时间点/)
    const result = await frames.call({ id, timestamps: [0, .25, .5, .75, 1, 1.25, 1.5], reason: 'page and state observations' })
    assert.equal(result.content.filter(item => item.type === 'image').length, 7)
    assert.equal((await frames.call({ id, timestamps: [2.5], reason: 'inspect transition' })).content.filter(item => item.type === 'image').length, 1)
  } finally { if (original === undefined) delete process.env.CLOUD_AGENT_MATERIAL_ROOT; else process.env.CLOUD_AGENT_MATERIAL_ROOT = original; await rm(root, { recursive: true, force: true }) }
})

test('scoped writes reject traversal, other apps, links and stale edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-path-'))
  try {
    await mkdir(path.join(root, 'app'))
    await writeFile(path.join(root, 'app/a.ets'), 'original')
    await link(path.join(root, 'app/a.ets'), path.join(root, 'app/linked.ets'))
    for (const relative of ['../outside', 'app/../secret', 'C:/private', 'app/secret:stream', 'other/a.ets', 'app/linked.ets']) await assert.rejects(scopedPath(root, relative, ['app']))
    await assert.rejects(writeScoped(root, 'app/new.ets', ['app'], 'x', 'wrong'), /新建文件.*new/)
    await writeScoped(root, 'app/new.ets', ['app'], 'x', 'new')
    await assert.rejects(writeScoped(root, 'app/new.ets', ['app'], 'y', 'new'), /变化/)
    await assert.rejects(writeScoped(root, 'app/hvigorfile.ts', ['app'], 'x', 'new'), /配置/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real worktrees isolate concurrent branches; real Harness rejects coding before human gates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-harness-fixture-'))
  const previous = process.env.CLOUD_AGENT_RUNTIME_ROOT
  const previousWorktrees = process.env.CLOUD_AGENT_WORKTREE_ROOT
  process.env.CLOUD_AGENT_RUNTIME_ROOT = path.join(root, 'runtime')
  process.env.CLOUD_AGENT_WORKTREE_ROOT = path.join(root, 'worktrees')
  const signal = AbortSignal.timeout(180000)
  const runGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=NUL', ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    const repo = path.join(root, 'repo')
    await mkdir(path.join(repo, 'app'), { recursive: true })
    runGit(repo, 'init')
    runGit(repo, 'config', 'user.name', 'Fixture'); runGit(repo, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(repo, 'app/Main.ets'), 'export class Main {}\n')
    runGit(repo, 'add', '.'); runGit(repo, 'commit', '-m', 'fixture')
    const sha = runGit(repo, 'rev-parse', 'HEAD'), cache = path.join(root, 'cache.git')
    execFileSync('git', ['clone', '--bare', repo, cache], { windowsHide: true, stdio: 'pipe' })
    const a = await taskWorktree(cache, sha, 'task-a', 'harmony', signal)
    const b = await taskWorktree(cache, sha, 'task-b', 'harmony', signal)
    await writeFile(path.join(a.root, 'app/Independent.ets'), 'independent')
    assert.equal(runGit(b.root, 'status', '--porcelain'), '')
    assert.equal(runGit(repo, 'status', '--porcelain'), '')
    assert.equal((await taskWorktree(cache, sha, 'task-a', 'harmony', signal)).root, a.root)
    assert.equal(await readFile(path.join(a.root, 'app/Independent.ets'), 'utf8'), 'independent')
    await handshakeHarness(signal)
    const artifactRoot = path.join(root, 'artifacts')
    const workspace: HarnessWorkspace = { identity: 'task-b', artifactRoot, runDir: path.join(artifactRoot, 'harness'), androidRoot: repo,
      harmonyRoot: b.root, branch: b.branch, baseSha: sha, androidPrefixes: ['app'], harmonyPrefixes: ['app'], appId: 'fixture', title: 'Fixture migration', profile: path.join(artifactRoot, 'profile.md') }
    const tools = await executionTools(workspace, signal, async () => {})
    await tools.find(tool => tool.definition.name === 'harness_start')!.call({ androidEntry: 'app/Main.ets', harmonyTarget: 'app' })
    const result = await verifyHarness(workspace, signal)
    assert.equal(result.status.nodes.length, 12)
    assert.ok(result.status.blockers.length)
    await assert.rejects(tools.find(tool => tool.definition.name === 'source_write')!.call({ path: 'app/Main.ets', content: 'forged', expectedSha256: sha256('export class Main {}\n') }), /门禁/)
    for (const name of ['source_edit', 'source_delete', 'source_move']) {
      await assert.rejects(tools.find(tool => tool.definition.name === name)!.call({ path: 'app/Main.ets', targetPath: 'Main.ets', expectedSha256: sha256('export class Main {}\n'), edits: [{ oldText: 'Main', newText: 'Changed' }] }), /门禁/)
    }
    assert.equal((await readFile(path.join(b.root, 'app/Main.ets'), 'utf8')).replace(/\r\n/g, '\n'), 'export class Main {}\n')
  } finally {
    if (previous === undefined) delete process.env.CLOUD_AGENT_RUNTIME_ROOT; else process.env.CLOUD_AGENT_RUNTIME_ROOT = previous
    if (previousWorktrees === undefined) delete process.env.CLOUD_AGENT_WORKTREE_ROOT; else process.env.CLOUD_AGENT_WORKTREE_ROOT = previousWorktrees
    await rm(root, { recursive: true, force: true })
  }
})
