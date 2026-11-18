import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nestedWorktree } from './worktrees'
import { listAndroidFiles, verifyAndroidSources } from './android-sources'
import { executionTools, type HarnessWorkspace } from './harness'

test('nested frozen worktree is searchable/readable and rejects drift and escape', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cloud-nested-'))
  const signal = AbortSignal.timeout(60000)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', windowsHide: true }).trim()
  try {
    const parent = path.join(temp, 'parent'), nested = path.join(temp, 'nested'), cache = path.join(temp, 'cache.git')
    for (const root of [parent, nested]) { await mkdir(root); git(root, 'init'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid') }
    await writeFile(path.join(parent, 'Entry.java'), 'class Entry {}')
    git(parent, 'add', '.'); git(parent, 'commit', '-m', 'fixture')
    await mkdir(path.join(nested, 'allowed'))
    await mkdir(path.join(nested, 'other'))
    await writeFile(path.join(nested, 'allowed/Player.java'), 'class Player {}')
    await writeFile(path.join(nested, 'other/Secret.java'), 'secret')
    git(nested, 'add', '.'); git(nested, 'commit', '-m', 'fixture')
    git(temp, 'clone', '--bare', nested, cache)
    const sha = git(nested, 'rev-parse', 'HEAD')
    await nestedWorktree(cache, sha, parent, 'lib', signal)
    await writeFile(path.join(nested, 'allowed/Player.java'), 'changed original')
    const workspace: HarnessWorkspace = { identity: 'fixture', artifactRoot: temp, runDir: temp, androidRoot: parent, harmonyRoot: parent, branch: 'test', baseSha: git(parent, 'rev-parse', 'HEAD'), androidPrefixes: ['Entry.java', 'lib/allowed'], harmonyPrefixes: [''], appId: 'fixture', title: 'test', profile: '', androidSources: [{ id: 'lib', suffix: 'lib', sha, cache, branch: 'main', configDigest: 'fixture' }] }
    const files = await listAndroidFiles(workspace, signal)
    assert.ok(files.includes('Entry.java'))
    assert.ok(files.includes('lib/allowed/Player.java'))
    assert.ok(!files.includes('lib/other/Secret.java'))
    const tools = await executionTools(workspace, signal, async () => {}, false)
    const result = await tools.find(tool => tool.definition.name === 'source_read')!.call({ platform: 'android', path: 'lib/allowed/Player.java' })
    const content = result.content[0]
    assert.equal(content.type, 'text')
    if (content.type === 'text') { const value = JSON.parse(content.text); assert.equal(value.text, 'class Player {}'); assert.equal(value.sourceCommit, sha) }
    await assert.rejects(tools.find(tool => tool.definition.name === 'source_read')!.call({ platform: 'android', path: 'lib/other/Secret.java' }))
    await nestedWorktree(cache, sha, parent, 'lib', signal)
    await assert.rejects(nestedWorktree(cache, sha, parent, '../escape', signal))
    await writeFile(path.join(parent, 'lib/allowed/Player.java'), 'tampered')
    await assert.rejects(verifyAndroidSources(workspace, signal), /变化/)
    await assert.rejects(nestedWorktree(cache, sha, parent, 'lib', signal), /修改/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
