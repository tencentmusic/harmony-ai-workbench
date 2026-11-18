import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessWorkspace } from './harness'
import { CloudRecoveryError, record } from './domain'
import { sha256 } from './scoped-files'
import { prepareAcceptanceCapture, executeAcceptanceCapture, captureAfterDeviceTest } from './acceptance-capture'
import { acceptanceTools } from './acceptance-tools'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-acceptance-capture-'))
  const workspace = { artifactRoot: root, runDir: path.join(root, 'harness') } as HarnessWorkspace
  await mkdir(workspace.runDir)
  const parity = { ui_scope: { status: 'required', states: [{ id: 'home' }] }, ui_review: { status: 'approved', required_states: ['home'] } }
  await writeFile(path.join(workspace.runDir, 'parity-matrix.json'), JSON.stringify(parity))
  await writeFile(path.join(workspace.runDir, 'verification-report.json'), JSON.stringify({ device: { environment: {} } }))
  const save = async (file: string, value: unknown) => {
    const contents = JSON.stringify(value)
    await writeFile(file, contents)
    return { path: file, sha256: sha256(contents) }
  }
  const scenario = async (startedAt: number) => {
    const outputRoot = path.join(root, 'execution', 'native-device-synthetic')
    await mkdir(outputRoot, { recursive: true })
    const execution = await save(path.join(outputRoot, 'execution.json'), {
      status: 'passed', scenario_id: 'SC-HOME', session: { started_at: new Date(startedAt).toISOString() },
    })
    const result = await save(path.join(outputRoot, 'result.json'), { status: 'passed', scenarioId: 'SC-HOME', execution })
    await save(path.join(outputRoot, 'completed.json'), { result })
    return { status: 'passed', scenarioId: 'SC-HOME', outputRoot }
  }
  return { root, workspace, parity, scenario, close: () => rm(root, { recursive: true, force: true }) }
}

test('capture preflight rejects unknown/unapproved state and transform before any execution', async () => {
  const f = await fixture()
  try {
    for (const state of [undefined, '', '../home', 'unknown']) {
      await assert.rejects(prepareAcceptanceCapture(f.workspace, 'capture', state, undefined))
    }
    await assert.rejects(prepareAcceptanceCapture(f.workspace, 'capture', 'home', [{ op: 'paint' }]), /转换/)
    f.parity.ui_review.status = 'pending'
    await writeFile(path.join(f.workspace.runDir, 'parity-matrix.json'), JSON.stringify(f.parity))
    await assert.rejects(prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined), /approved|批准/)
    f.parity.ui_review.status = 'approved'
    f.parity.ui_scope.status = 'not_applicable'
    await writeFile(path.join(f.workspace.runDir, 'parity-matrix.json'), JSON.stringify(f.parity))
    await assert.rejects(prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined))
  } finally { await f.close() }
})

test('standalone and co-located capture use real native capture then comparison, never review or navigation', async () => {
  const f = await fixture()
  try {
    const transform = [{ op: 'resize', width: 582, height: 1280, resample: 'lanczos' }]
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', transform)
    const calls: string[] = []
    const result = await executeAcceptanceCapture(f.workspace, capture, {
      gate: async () => { calls.push('gate') },
      claimDevice: async () => { calls.push('lock'); return { hdc: 'synthetic-hdc', target: 'synthetic-target' } },
      command: async argv => {
        calls.push(argv[0])
        assert.ok(!argv.includes('--prepare-installation'))
        assert.equal(argv[argv.indexOf('--state-id') + 1], 'home')
        if (argv[0] === 'capture-screen') await writeFile(capture.imagePath, 'SYNTHETIC IMAGE')
        else {
          assert.equal(argv[argv.indexOf('--harmony-capture') + 1], capture.imagePath)
          assert.deepEqual(JSON.parse(await readFile(argv[argv.indexOf('--capture-transform') + 1], 'utf8')), transform)
          await writeFile(argv[argv.indexOf('--comparison-report') + 1], JSON.stringify({ status: 'failed' }))
        }
        return '{}'
      },
      saveReport: async () => { calls.push('report') },
    })
    assert.deepEqual(calls, ['gate', 'lock', 'capture-screen', 'compare-visual', 'report'])
    assert.equal(result.status, 'captured')
    assert.equal(result.automaticStatus, 'failed')
    assert.equal(result.humanReviewRequired, true)
    assert.match(path.basename(result.comparison.path), /^comparison-[a-f0-9]{16}\.json$/)
    assert.equal(result.comparisonEnvironmentSha256, sha256('{}'))
    const pilotDirectory = 'C:/AndroidProject/android-to-harmony/kugou-harmony-ai-workbench/.runtime/cloud-agent/tasks/cmumctcdy0000l8p0nvffqo9n-2/artifacts/execution/closeout-recommend_static-20261014-a'
    const nativeImage = path.join(pilotDirectory, path.basename(result.comparison.path, '.json') + '.visual-abcdefgh', 'pair-1-comparison.png')
    assert.ok(nativeImage.length < 260)
    assert.equal(result.image.sha256, sha256('SYNTHETIC IMAGE'))
    await assert.rejects(prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined), /其他/)
  } finally { await f.close() }
})

test('passed scenario captures once; replay returns hash-checked visual result without device commands', async () => {
  const f = await fixture()
  try {
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined)
    const start = Date.now(), result = await f.scenario(start + 10)
    let count = 0
    const execute = async () => {
      count++
      await writeFile(capture.imagePath, 'SYNTHETIC IMAGE')
      await writeFile(capture.comparisonPath, '{"status":"passed"}')
      return { status: 'captured' as const, operationId: capture.operationId, stateId: 'home', humanReviewRequired: true as const,
        automaticStatus: 'passed', comparisonEnvironmentSha256: sha256('{}'), image: { path: capture.imagePath, sha256: sha256('SYNTHETIC IMAGE') },
        comparison: { path: capture.comparisonPath, sha256: sha256('{"status":"passed"}') } }
    }
    const first = await captureAfterDeviceTest(f.workspace, capture, result, start, new AbortController().signal, execute)
    assert.equal(first.status, 'captured')
    const replay = await captureAfterDeviceTest(f.workspace, capture, result, start + 1000, new AbortController().signal, execute)
    assert.deepEqual(replay, first)
    assert.equal(count, 1)
    await writeFile(path.join(f.workspace.runDir, 'verification-report.json'), JSON.stringify({ device: { environment: { tested_at: 'updated' } } }))
    const refresh = await captureAfterDeviceTest(f.workspace, capture, result, start + 1500, new AbortController().signal, execute)
    assert.equal(refresh.status === 'captured' && refresh.comparisonRefreshRequired, true)
    assert.match(refresh.nextAction || '', /harness_capture/)
    assert.equal(count, 1)
    await writeFile(capture.imagePath, 'TAMPERED')
    const invalid = await captureAfterDeviceTest(f.workspace, capture, result, start + 2000, new AbortController().signal, execute)
    assert.equal(invalid.status, 'failed')
    assert.equal(count, 1)
    assert.equal(result.status, 'passed')
  } finally { await f.close() }
})

test('reused or failed native scenarios do not capture an unrelated current page', async () => {
  const f = await fixture()
  try {
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined)
    const start = Date.now(), result = await f.scenario(start - 1000)
    const execute = async (): Promise<never> => { throw new Error('must not capture') }
    const reused = await captureAfterDeviceTest(f.workspace, capture, result, start, new AbortController().signal, execute)
    assert.equal(reused.status, 'skipped')
    assert.match('reason' in reused ? reused.reason ?? '' : '', /reused/)
    const failed = await captureAfterDeviceTest(f.workspace, capture, { ...result, status: 'failed' }, start, new AbortController().signal, execute)
    assert.equal(failed.status, 'skipped')
    assert.match('reason' in failed ? failed.reason ?? '' : '', /not_passed/)
  } finally { await f.close() }
})

test('capture failures remain separate from passed device evidence and retries never call the device', async () => {
  const f = await fixture()
  try {
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined)
    const start = Date.now(), result = await f.scenario(start + 10)
    let calls = 0
    const execute = async (): Promise<never> => { calls++; throw new Error('snapshot failed') }
    const first = await captureAfterDeviceTest(f.workspace, capture, result, start, new AbortController().signal, execute)
    assert.equal(first.status, 'failed')
    assert.match('error' in first ? first.error ?? '' : '', /snapshot failed/)
    assert.match('nextAction' in first ? first.nextAction : '', /harness_capture/)
    assert.deepEqual(await captureAfterDeviceTest(f.workspace, capture, result, start + 1000, new AbortController().signal, execute), first)
    assert.equal(calls, 1)
    assert.equal(result.status, 'passed')
    assert.equal(JSON.parse(await readFile(path.join(result.outputRoot, 'result.json'), 'utf8')).status, 'passed')
  } finally { await f.close() }
})

test('uncertain capture retains recovery requirement; changed execution cannot reuse earlier capture', async () => {
  const f = await fixture()
  try {
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined)
    const start = Date.now(), result = await f.scenario(start + 10)
    const execute = async (): Promise<never> => { throw new CloudRecoveryError('capture process uncertain', 409) }
    const first = await captureAfterDeviceTest(f.workspace, capture, result, start, new AbortController().signal, execute)
    assert.equal(first.status, 'recovery_required')
    const changed = await f.scenario(start + 100)
    const invalid = await captureAfterDeviceTest(f.workspace, capture, changed, start, new AbortController().signal, execute)
    assert.equal(invalid.status, 'failed')
    assert.match('error' in invalid ? invalid.error ?? '' : '', /different|其他/)
  } finally { await f.close() }
})

test('comparison refresh reuses capture operation while preserving prior comparison files', async () => {
  const f = await fixture()
  try {
    const capture = await prepareAcceptanceCapture(f.workspace, 'capture', 'home', undefined)
    const operations = new Set<string>()
    let deviceCaptures = 0
    const io = {
      gate: async () => {}, claimDevice: async () => ({ hdc: 'synthetic', target: 'synthetic' }), saveReport: async () => {},
      command: async (argv: string[]) => {
        const id = argv[argv.indexOf('--operation-id') + 1]
        if (!operations.has(id)) {
          operations.add(id)
          if (argv[0] === 'capture-screen') { deviceCaptures++; await writeFile(capture.imagePath, 'SYNTHETIC IMAGE') }
          else await writeFile(argv[argv.indexOf('--comparison-report') + 1], '{"status":"failed"}')
        }
        return '{}'
      },
    }
    const first = await executeAcceptanceCapture(f.workspace, capture, io)
    await writeFile(path.join(f.workspace.runDir, 'verification-report.json'), JSON.stringify({ device: { environment: { tested_at: 'changed' } } }))
    const refreshed = await executeAcceptanceCapture(f.workspace, capture, io)
    assert.equal(deviceCaptures, 1)
    assert.notEqual(first.comparison.path, refreshed.comparison.path)
    assert.deepEqual(first.image, refreshed.image)
    assert.equal(await readFile(first.comparison.path, 'utf8'), '{"status":"failed"}')
    assert.equal(refreshed.automaticStatus, 'failed')
    assert.equal(refreshed.humanReviewRequired, true)
  } finally { await f.close() }
})

test('tool schema exposes optional explicit capture, validates before devices, and rejects external capture', async () => {
  const f = await fixture()
  const tools = await acceptanceTools({ ...f.workspace, appId: 'synthetic-no-executor' }, new AbortController().signal, async () => {})
  try {
    const run = tools.tools.find(tool => tool.definition.name === 'harness_test')!
    assert.deepEqual(run.definition.inputSchema.required, ['operationId'])
    assert.equal(record(run.definition.inputSchema.properties!.captureStateId).type, 'string')
    assert.equal(record(run.definition.inputSchema.properties!.captureTransform).type, 'array')
    await assert.rejects(run.call({ operationId: 'test', planPath: 'candidates/plan.json', captureTransform: [] }), /captureStateId/)
    await assert.rejects(run.call({ operationId: 'test', planPath: 'candidates/plan.json', captureStateId: 'home' }), /native/)
    const capture = tools.tools.find(tool => tool.definition.name === 'harness_capture')!
    await assert.rejects(capture.call({ operationId: 'test', stateId: 'unknown' }), /approved canonical/)
  } finally { await tools.close(); await f.close() }
})
