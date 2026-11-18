import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { checkBuildEnvironment, buildPreflightGuard, checkHarmonySdkEnvironment } from './build-preflight'
import { CloudEnvironmentError } from './domain'
import { harnessEnvironment } from './harness'

test('native environment preserves Windows package-manager paths without inheriting secrets', () => {
  const env = harnessEnvironment()
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'ProgramFiles']) assert.equal(env[key], process.env[key])
  for (const key of ['SUB2API_API_KEY', 'CLOUD_AGENT_GITLAB_TOKEN', 'NODE_OPTIONS', 'DATABASE_URL']) assert.equal(env[key], undefined)
})

test('SDK preflight rejects absent, relative and non-directory configuration before compilation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-sdk-preflight-'))
  try {
    await assert.rejects(checkHarmonySdkEnvironment(''), /DEVECO_SDK_HOME/)
    await assert.rejects(checkHarmonySdkEnvironment('relative/sdk'), /DEVECO_SDK_HOME/)
    await assert.rejects(checkHarmonySdkEnvironment(path.join(root, 'missing')), /DEVECO_SDK_HOME/)
    await writeFile(path.join(root, 'file'), 'not a directory')
    await assert.rejects(checkHarmonySdkEnvironment(path.join(root, 'file')), /DEVECO_SDK_HOME/)
    await checkHarmonySdkEnvironment(root)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native build preflight checks trust, existence and command without executing tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-build-preflight-'))
  const previous = process.env.MIGRATION_HARNESS_DEVECO_TOOLS
  try {
    const trusted = path.join(root, 'tools'), repo = path.join(root, 'repo')
    await mkdir(trusted); await mkdir(repo)
    const node = path.join(trusted, 'node.exe'), hvigor = path.join(trusted, 'hvigorw.js')
    await writeFile(node, 'TEST ONLY - NOT EXECUTABLE')
    await writeFile(hvigor, 'throw new Error("must not execute")')
    const command = [node, hvigor, 'assembleHap', '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=debug']
    process.env.MIGRATION_HARNESS_DEVECO_TOOLS = '[]'
    await assert.rejects(checkBuildEnvironment(repo, command, AbortSignal.timeout(30000)), /DEVECO_HOME/)
    process.env.MIGRATION_HARNESS_DEVECO_TOOLS = JSON.stringify([trusted])
    await checkBuildEnvironment(repo, command, AbortSignal.timeout(30000))
    await assert.rejects(checkBuildEnvironment(repo, command.slice(0, 2), AbortSignal.timeout(30000)), /must run assemble/)
    await assert.rejects(checkBuildEnvironment(repo, [path.join(trusted, 'missing.exe'), ...command.slice(1)], AbortSignal.timeout(30000)), CloudEnvironmentError)
  } finally {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_DEVECO_TOOLS
    else process.env.MIGRATION_HARNESS_DEVECO_TOOLS = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed environment failure is checked once per batch; transient failure is retryable', async () => {
  let attempts = 0
  const guarded = buildPreflightGuard(async () => { attempts++; throw new CloudEnvironmentError('untrusted tools', 503) })
  await assert.rejects(guarded(), /untrusted tools/)
  await assert.rejects(guarded(), /untrusted tools/)
  assert.equal(attempts, 1)
  const freshBatch = buildPreflightGuard(async () => { attempts++ })
  await freshBatch()
  assert.equal(attempts, 2)
  let transient = 0
  const retryable = buildPreflightGuard(async () => { if (++transient === 1) throw new Error('temporary failure') })
  await assert.rejects(retryable(), /temporary failure/)
  await retryable()
  assert.equal(transient, 2)
})
