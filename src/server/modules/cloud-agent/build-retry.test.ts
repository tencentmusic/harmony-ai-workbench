import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readExecutionLog, buildExecutionId, compilerDiagnostic, previousBuildFailure, buildFailureMessage, needsFreshPackageBuild } from './build-retry'

test('fresh package retry only matches incremental signed-package absence', () => {
  assert.equal(needsFreshPackageBuild('hvigor UP-TO-DATE :network:default@SignHsp\nENOENT copyfile C:/project/network-default-signed.hsp'), true)
  assert.equal(needsFreshPackageBuild('ENOENT C:/project/network-default-signed.hsp'), false)
  assert.equal(needsFreshPackageBuild('UP-TO-DATE :network:default@SignHsp\nENOENT C:/source/foo.ets'), false)
  assert.equal(needsFreshPackageBuild('BUILD FAILED: ArkTS Compiler Error'), false)
})

test('large NUL-bearing build logs are readable in bounded pages without changing evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'build-log-'))
  try {
    await mkdir(path.join(root, 'execution', 'attempt'), { recursive: true })
    const relative = 'execution/attempt/build.log', file = path.join(root, relative)
    const original = Buffer.from('warning\n'.repeat(300000) + '\0virtual-module\n\x1b[31mERROR: ArkTS Compiler Error\x1b[0m\nError Message: Declaring fields in constructor is not supported\nAt File: app/player.ets:170:49\n')
    await writeFile(file, original)
    const tail = await readExecutionLog(root, relative)
    assert.match(tail.text, /\\0virtual-module/)
    assert.match(compilerDiagnostic(tail.text), /Declaring fields in constructor/)
    assert.ok(!tail.text.includes('\x1b'))
    assert.equal(tail.nextOffset, null)
    assert.equal(tail.size, original.length)
    const first = await readExecutionLog(root, relative, 0)
    assert.equal(first.offset, 0)
    assert.ok(first.nextOffset! > 0)
    const next = await readExecutionLog(root, relative, first.nextOffset!)
    assert.equal(next.offset, first.nextOffset)
    assert.deepEqual(await readFile(file), original)
    for (const offset of [-1, 0.2, NaN, original.length + 1]) await assert.rejects(readExecutionLog(root, relative, offset))
    for (const unsafe of ['../outside.log', 'harness/manifest.json', 'execution/attempt/../../secret.log']) await assert.rejects(readExecutionLog(root, unsafe))
    await symlink(root, path.join(root, 'execution', 'alias'), 'junction')
    await assert.rejects(readExecutionLog(root, 'execution/alias/build.log'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('build operation binding changes with source/config but not object key order', () => {
  const source = { head: 'a', worktree_fingerprint: 'b' }, config = { command: ['hvigor', 'build'], cwd: 'app' }
  const id = buildExecutionId('requested-id', source, config)
  assert.match(id, /^build-[a-f0-9]{40}$/)
  assert.equal(id, buildExecutionId('requested-id', { worktree_fingerprint: 'b', head: 'a' }, { cwd: 'app', command: ['hvigor', 'build'] }))
  assert.notEqual(id, buildExecutionId('requested-id', { ...source, head: 'c' }, config))
  assert.notEqual(id, buildExecutionId('requested-id', source, { ...config, cwd: 'other' }))
  assert.throws(() => buildExecutionId('../escape', source, config))
})

test('successful compilation never hides native artifact failure under warnings', () => {
  const log = 'WARN: duplicate names\n'.repeat(2000) + 'BUILD SUCCESSFUL in 59s'
  const message = buildFailureMessage(new Error('did not regenerate the requested package'), log, 'execution/test/build.log')
  assert.match(message, /did not regenerate/)
  assert.match(message, /harness_build_context/)
  assert.doesNotMatch(message, /duplicate names/)
  assert.ok(message.length < 1000)
})

test('resume includes the recorded failed build diagnostic but not a passed build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'build-resume-'))
  const runDir = path.join(root, 'harness'), logPath = path.join(root, 'execution', 'attempt', 'build.log')
  try {
    await mkdir(runDir)
    await mkdir(path.dirname(logPath), { recursive: true })
    await writeFile(logPath, '\0virtual-module\nERROR: ArkTS Compiler Error\nAt File: app/player.ets:170:49\n')
    const report = path.join(runDir, 'verification-report.json')
    await writeFile(report, JSON.stringify({ build: { status: 'failed', evidence: { path: logPath } } }))
    const failure = await previousBuildFailure({ runDir, artifactRoot: root })
    assert.match(failure!.diagnostic, /app\/player.ets:170:49/)
    assert.equal(failure!.logPath, 'execution/attempt/build.log')
    const journal = path.join(runDir, 'harness-events.jsonl')
    await writeFile(logPath, 'BUILD SUCCESSFUL')
    await writeFile(journal, JSON.stringify({ command: 'run-build', status: 'failed', operation_id: 'attempt', error: 'did not regenerate the requested package' }) + '\n')
    const latest = await previousBuildFailure({ runDir, artifactRoot: root })
    assert.match(latest!.diagnostic, /did not regenerate/)
    assert.doesNotMatch(latest!.diagnostic, /player.ets/)
    await writeFile(journal, JSON.stringify({ command: 'run-build', status: 'committed', operation_id: 'attempt' }) + '\n')
    await writeFile(report, JSON.stringify({ build: { status: 'passed', evidence: { path: logPath } } }))
    assert.equal(await previousBuildFailure({ runDir, artifactRoot: root }), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
