import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { harnessRoot, verifyHarness, type HarnessWorkspace } from './harness'
import { registerPlan, savedPlan, acceptanceConfiguration, invokeRuntime, runtimeEvidence, hostGrants } from './native-runtime'
import { reviewExecutionPlan, approveExecutionPlan } from './execution-plan-review'
import { meetsNativePhase } from './harness-domain'
import { sha256 } from './scoped-files'

test('native runtime persists plans, human grants, budgets and replay without revoking passed gates', { timeout: 300000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-native-contract-'))
  const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp(); c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved(); c.mark_implemented(); c.mark_wired()
m=c.read('manifest'); p=c.read('parity'); print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':m,'scenarios':[s['id'] for s in p['scenarios']]}))
c.temporary._finalizer.detach()`
  const signal = AbortSignal.timeout(280000)
  try {
    const f = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'native-fixture', continuous: true, runtimeVersion: 1, materialVersion: 1, artifactRoot: f.manifest.artifact_root, runDir: f.run, androidRoot: f.android, harmonyRoot: f.harmony, branch: f.manifest.harmony.branch, baseSha: f.manifest.harmony.head, androidPrefixes: [''], harmonyPrefixes: [''], appId: 'fixture', title: 'SYNTHETIC native runtime test', profile: path.join(f.root, 'profile.md') }
    await assert.rejects(reviewExecutionPlan(workspace), /执行计划/)
    const before = await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')
    const plan = { scenarios: f.scenarios.map((scenario_id: string) => ({ scenario_id, coverage: ['controls'], effects: ['navigation'] })), dependencies: [] }
    await registerPlan(workspace, plan, 'plan', signal)
    assert.ok(await savedPlan(workspace))
    await registerPlan(workspace, plan, 'plan', signal)
    await assert.rejects(registerPlan(workspace, { ...plan, dependencies: [{ id: 'changed' }] }, 'plan', signal), /操作 ID/)
    await assert.rejects(registerPlan(workspace, { ...plan, authorizations: [{ id: 'forged' }] }, 'forged', signal), /真人/)
    assert.deepEqual(await acceptanceConfiguration(workspace), { kind: 'configure' })
    await mkdir(path.join(workspace.artifactRoot, 'candidates'), { recursive: true })
    await mkdir(path.join(workspace.artifactRoot, 'approvals'), { recursive: true })
    await writeFile(path.join(workspace.artifactRoot, 'candidates/execution-plan.json'), JSON.stringify({ requested_authorizations: [{ id: 'capped', scenario_ids: [f.scenarios[0]], effects: ['paid'], account_ref: 'synthetic-account', target_ref: 'synthetic-target', max_spend: 10, currency: 'CNY' }] }))
    const review = await reviewExecutionPlan(workspace)
    const file = path.join(workspace.artifactRoot, 'approvals/human.json')
    const proof = 'SYNTHETIC TEST: human approval fixture, no real spending permission'
    await writeFile(file, proof)
    await approveExecutionPlan(workspace, review!, { path: file, sha256: sha256(proof) }, 'human-plan', signal)
    assert.equal((await hostGrants(workspace)).length, 1)
    assert.equal((await acceptanceConfiguration(workspace)).policy?.max_spend, 10)
    await registerPlan(workspace, plan, 'plan-keep-grants', signal)
    assert.equal((await savedPlan(workspace))?.authorizations instanceof Array, true)
    await invokeRuntime(workspace, 'acceptance', await acceptanceConfiguration(workspace), 'configure', signal)
    await invokeRuntime(workspace, 'acceptance', { kind: 'clock', state: 'active', reason: 'synthetic host lease' }, 'clock-active', signal)
    const checked = await verifyHarness(workspace, signal, 'wired')
    assert.equal(checked.raw.verified, false)
    assert.equal(checked.status.acceptance?.configured, true)
    assert.equal(meetsNativePhase(checked.raw, 'wired'), true, JSON.stringify(checked.raw))
    assert.equal(meetsNativePhase(checked.raw, 'delivery_ready'), false)
    await invokeRuntime(workspace, 'acceptance', { kind: 'clock', state: 'wait', reason: 'synthetic batch stopped' }, 'clock-wait', signal)
    assert.equal(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8'), before)
    await assert.rejects(runtimeEvidence(workspace, { path: '../outside.txt', sha256: 'a'.repeat(64) }))
    await writeFile(file, 'tampered')
    await assert.rejects(acceptanceConfiguration(workspace), /摘要已变化/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
