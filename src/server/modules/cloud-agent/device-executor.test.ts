import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deviceExecutorIssue, requireDeviceExecutor, deviceExecutorExitCode, deviceChildFailure } from './device-executor'
import { CloudError, CloudEnvironmentError, CloudRecoveryError } from './domain'
import { sha256 } from './scoped-files'
import { parseExecutionConfig } from './execution-config'

test('a stopped child with an uncertain native action preserves recovery semantics', async () => {
  const code = deviceExecutorExitCode(new CloudRecoveryError('native action in doubt', 409), false)
  const running = promisify(execFile)(process.execPath, ['-e', `process.exit(${code})`], { windowsHide: true })
  const failure = await running.catch(error => error)
  assert.equal(running.child.exitCode, code)
  assert.equal(running.child.signalCode, null)
  assert.ok(deviceChildFailure(failure, running.child, false) instanceof CloudRecoveryError)
  assert.equal(deviceExecutorExitCode(new Error('cancelled'), true), code)
  assert.equal(deviceExecutorExitCode(new CloudError('invalid plan'), false), 1)
  assert.ok(deviceChildFailure({ code: 1, stderr: 'invalid plan' }, { exitCode: 1, signalCode: null }, false) instanceof CloudError)
  assert.ok(!(deviceChildFailure({ code: 1 }, { exitCode: 1, signalCode: null }, false) instanceof CloudRecoveryError))
  assert.ok(deviceChildFailure({}, { exitCode: null, signalCode: null }, false) instanceof CloudRecoveryError)
  assert.ok(deviceChildFailure({ code: 1 }, { exitCode: 1, signalCode: null }, true) instanceof CloudRecoveryError)
})

test('native execution is explicitly configured and cannot silently override an external adapter', async () => {
  const config = parseExecutionConfig({ device: { hdc: process.execPath, executor: 'native' } })
  assert.equal(deviceExecutorIssue(config.device), '')
  await assert.rejects(requireDeviceExecutor(config.device), /内置/)
  assert.throws(() => parseExecutionConfig({ device: { hdc: process.execPath, executor: 'native', descriptor: process.execPath, descriptor_sha256: 'a'.repeat(64) } }), /混配/)
  assert.throws(() => parseExecutionConfig({ device: { hdc: process.execPath, executor: 'unknown' } }))
})

test('formal executor preflight reports missing/unreadable/changed config without requiring a device', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'executor-check-'))
  try {
    assert.match(deviceExecutorIssue({ hdc: 'hdc' }), /descriptor/)
    await assert.rejects(requireDeviceExecutor({ hdc: 'hdc' }), CloudEnvironmentError)
    const descriptor = path.join(root, 'adapter.json'), bytes = '{}'
    const config = { hdc: 'hdc', descriptor, descriptorSha256: sha256(bytes) }
    await assert.rejects(requireDeviceExecutor(config), /读取/)
    await writeFile(descriptor, bytes)
    assert.equal(await requireDeviceExecutor(config), descriptor)
    await writeFile(descriptor, '{"changed":true}')
    await assert.rejects(requireDeviceExecutor(config), /指纹/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
