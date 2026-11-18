import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { harnessRoot, type HarnessWorkspace } from './harness'
import { runDeviceScenario } from './device-runner'
import { checkedEvidence, immutableJson } from './device-evidence'
import { sha256, relativeToRoot, inProjectScope } from './scoped-files'
import { CloudRecoveryError, record } from './domain'
import { deviceExecutorFingerprint, registerDeviceResults } from './native-device-executor'
import { reviewDeviceExecution } from './device-review'

test('native executor validates synthetic raw observations, rejects failed assertions and retains uncertain steps', { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-device-executor-test-'))
  try {
    const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory; tempfile.TemporaryDirectory=lambda:original(dir=sys.argv[2])
c=f.MigrationHarnessTests();c.setUp();c.mark_context();c.mark_evidence();c.mark_scope();c.mark_ui_approved();c.mark_implemented();c.mark_wired();c.mark_build()
p=c.read('parity');s=p['scenarios'][0];s['actions']=[{'id':'ACT-OPEN','kind':'tap','target':'SYNTHETIC Live'}];s['assertions']=[{'id':'ASSERT-LIVE','action_id':'ACT-OPEN','observation_kind':'ui_snapshot','selector':'live.cover','type':'exists','expected':True}];c.write('parity',p)
print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':c.read('manifest'),'scenario':s}));c.temporary._finalizer.detach()`
    const f = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-B', '-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'synthetic-device', continuous: true, materialVersion: 1, artifactRoot: f.manifest.artifact_root, runDir: f.run, androidRoot: f.android, harmonyRoot: f.harmony, branch: f.manifest.harmony.branch, baseSha: f.manifest.harmony.head, androidPrefixes: [''], harmonyPrefixes: [''], appId: 'synthetic', title: 'SYNTHETIC ONLY', profile: path.join(f.root, 'profile.md') }
    const device = { hdc: process.execPath, target: 'device-test', bundle: f.manifest.application.bundle_name, ability: 'EntryAbility' }
    const fixtureRelative = await relativeToRoot(workspace.artifactRoot, f.scenario.fixture.artifact.path)
    assert.ok(inProjectScope(fixtureRelative), JSON.stringify({ root: workspace.artifactRoot, fixture: f.scenario.fixture.artifact, fixtureRelative }))
    const plan = { version: 1, scenarioId: f.scenario.id, accountOrRoom: 'SYNTHETIC ONLY', actions: [{ id: 'ACT-OPEN', steps: [{ kind: 'text_tap', text: 'SYNTHETIC Live' }, { kind: 'home' }, { kind: 'observe' }], bindings: [{ assertionId: 'ASSERT-LIVE', where: { id: 'cover' }, field: 'bounds' }] }] }
    for (const mode of ['passed', 'missing', 'uncertain', 'settlement'] as const) {
      const outputRoot = path.join(workspace.artifactRoot, `executor-${mode}`)
      await mkdir(outputRoot, { recursive: true })
      const events: Record<string, unknown>[] = []
      const operationId = `synthetic-${mode}`
      const promise = runDeviceScenario({ workspace, plan, device, operationId, outputRoot, installationSessionId: 'synthetic-install' }, AbortSignal.timeout(120000), {
        cwd: outputRoot, environment: async () => ({ stdout: 'SYNTHETIC_TEST_VALUE', stderr: '' }),
        invoke: async (_workspace, action, payload) => {
          if (action === 'acceptance') {
            events.push(record(payload))
            if (mode === 'settlement' && record(payload).kind === 'finish') throw new CloudRecoveryError('SYNTHETIC settlement interrupted', 409)
            return {}
          }
          if (mode === 'uncertain') throw new CloudRecoveryError('SYNTHETIC in doubt', 409)
          const layout = await immutableJson(path.join(outputRoot, 'layout.json'), { synthetic: true })
          const screenshotFile = path.join(outputRoot, 'screenshot.txt')
          await writeFile(screenshotFile, 'SYNTHETIC screenshot bytes; not real device evidence')
          return { receipt: { status: 'completed', observations: [{ at: Date.now() / 1000, layout, screenshot: { path: screenshotFile, sha256: sha256(await readFile(screenshotFile)) }, nodes: [{ id: mode !== 'missing' ? 'cover' : 'not-cover', bundleName: record(record(payload).action).kind === 'home' ? 'com.ohos.sceneboard' : device.bundle, visible: 'true', bounds: '[1,2][30,40]' }] }] } }
        },
      })
      if (mode === 'uncertain') {
        await assert.rejects(promise, CloudRecoveryError)
        assert.equal(events.filter(event => event.kind === 'finish').length, 0)
      } else if (mode === 'settlement') {
        await assert.rejects(promise, CloudRecoveryError)
        await assert.rejects(readFile(path.join(outputRoot, 'completed.json')), /ENOENT/)
        let settlements = 0
        const recovered = await runDeviceScenario({ workspace, plan, device, operationId, outputRoot, installationSessionId: 'synthetic-install' }, AbortSignal.timeout(30000), {
          invoke: async (_workspace, action, payload) => { assert.equal(action, 'acceptance'); assert.equal(record(payload).kind, 'finish'); settlements++; return {} },
          environment: async () => { throw new Error('Must not re-query or replay devices') },
        })
        assert.equal(settlements, 1)
        assert.equal(recovered.status, 'passed')
        const completed = JSON.parse(await readFile(path.join(outputRoot, 'completed.json'), 'utf8'))
        assert.equal(completed.operationId, operationId)
        await checkedEvidence(workspace, completed.result)
      } else {
        const result = await promise
        assert.equal(result.status, mode === 'passed' ? 'passed' : 'failed', JSON.stringify(result.issues))
        assert.equal(events.filter(event => event.kind === 'finish').length, 1)
        assert.equal(events[0].phase, 'execute')
        if (mode === 'passed') {
          const index = path.join(workspace.artifactRoot, 'device-tests')
          await mkdir(index, { recursive: true })
          const resultPath = path.join(outputRoot, 'result.json')
          await immutableJson(path.join(index, `${sha256(plan.scenarioId)}.json`), { result: { path: resultPath, sha256: sha256(await readFile(resultPath)) }, executor: await deviceExecutorFingerprint() })
          const aggregated = await registerDeviceResults(workspace, AbortSignal.timeout(120000))
          assert.deepEqual(aggregated.missing, [])
          assert.equal(aggregated.deviceStatus, 'passed')
          await assert.rejects(reviewDeviceExecution(workspace, 'SYNTHETIC', AbortSignal.timeout(30000), async () => {}, async () => '{}'), /完整读取/)
          const reviewed = await reviewDeviceExecution(workspace, 'SYNTHETIC', AbortSignal.timeout(120000), async () => {}, async input => {
            assert.equal(input.deviceReview, true)
            const required = JSON.parse(input.prompt.match(/必须完整阅读：(\[.*\])。先读/s)![1]) as string[]
            assert.ok(required.some(file => /device-review\/packets\/.*\.json$/.test(file)), 'per-case proof packet must be required')
            const client = new Client({ name: 'SYNTHETIC-reviewer', version: '1.0.0' })
            try {
              await client.connect(new StreamableHTTPClientTransport(new URL(input.taskMcp!.url), { requestInit: { headers: input.taskMcp!.headers } }))
              for (const file of required) {
                let offset: number | null = 0
                const pages: string[] = []
                do {
                  const response = await client.callTool({ name: 'device_review_read', arguments: { path: file, offset } })
                  assert.notEqual(response.isError, true)
                  const content = response.content as { type: string; text: string }[]
                  if (content[0].type === 'image') { offset = null; continue }
                  const separator = content[0].text.indexOf('\n')
                  assert.ok(separator > 0)
                  const metadata = JSON.parse(content[0].text.slice(0, separator))
                  const page = content[0].text.slice(separator + 1)
                  assert.equal(metadata.path, file)
                  assert.match(metadata.sha256, /^[a-f0-9]{64}$/)
                  assert.ok(page.length <= 6000)
                  if (metadata.nextOffset !== null) assert.equal(metadata.nextOffset, offset + page.length)
                  pages.push(page)
                  offset = metadata.nextOffset
                } while (offset !== null)
                if (pages.length && file.endsWith('.json')) {
                  const decoded = JSON.parse(pages.join(''))
                  if (decoded.original_files) assert.ok(decoded.original_files.some((value: string) => value.endsWith('/raw-0-1.json')), 'non-app intermediate raw receipt remains accessible')
                }
                else if (pages.length) assert.equal(pages.join(''), await readFile(path.join(workspace.artifactRoot, file), 'utf8'))
              }
              return JSON.stringify({ summary: 'SYNTHETIC reviewer transport test, not real acceptance', cases: [{ caseId: `F-${plan.scenarioId}`, decision: 'passed', assertionIds: ['ASSERT-LIVE'], evidence: 'SYNTHETIC raw nodes only, validator test' }] })
            } finally { await client.close() }
          })
          assert.equal(reviewed.status, 'passed')
          const reused = await reviewDeviceExecution(workspace, 'SYNTHETIC', AbortSignal.timeout(120000), async () => {}, async () => { throw new Error('Unchanged reviewed cases must not invoke the model again') })
          assert.equal(reused.status, 'passed')
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('executor immutable receipts cannot be replaced under the same operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-device-receipt-test-'))
  try {
    const file = path.join(root, 'receipt.json')
    const first = await immutableJson(file, { synthetic: true })
    assert.deepEqual(await immutableJson(file, { synthetic: true }), first)
    await assert.rejects(immutableJson(file, { synthetic: false }), /操作 ID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
