import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareNativeReview, applyNativeReview } from './harness-review'
import { harnessRoot, verifyHarness, type HarnessWorkspace } from './harness'
import type { CloudHarness } from '@/contracts/cloud-agent'

test('visual review still needs a verified current build', async () => {
  const status = { phase: 'wired', nodes: [{ id: 'build_passed', status: 'blocked' }] } as CloudHarness
  assert.equal(await prepareNativeReview({} as HarnessWorkspace, status, new AbortController().signal), null)
})

test('failed current-build visual comparison can be accepted while device cases remain pending', async () => {
  const previousTools = process.env.MIGRATION_HARNESS_DEVECO_TOOLS
  process.env.MIGRATION_HARNESS_DEVECO_TOOLS = JSON.stringify([path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests/fixtures')])
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-visual-difference-'))
  const script = `import sys,json,tempfile,argparse,contextlib,io
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp()
c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved(); c.mark_implemented(); c.mark_wired(); c.mark_build(); c.mark_device()
v=c.read('verification'); v['device']['status']='not_run'; v['device']['cases']=[]; c.write('verification',v)
capture=c.run_dir/'evidence/different.png'; c.register_capture_fixture(capture,color=(10,40,90))
with contextlib.redirect_stdout(io.StringIO()):
 f.HARNESS.compare_visual_run(argparse.Namespace(run_dir=str(c.run_dir),state_id='live',harmony_capture=str(capture),comparison_report=str(c.run_dir/'evidence/different.json')))
print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':c.read('manifest')}))
c.temporary._finalizer.detach()`
  const signal = AbortSignal.timeout(300000)
  try {
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: fixture.manifest.run_id, continuous: true, materialVersion: 1, artifactRoot: fixture.manifest.artifact_root,
      runDir: fixture.run, androidRoot: fixture.android, harmonyRoot: fixture.harmony, branch: fixture.manifest.harmony.branch, baseSha: fixture.manifest.harmony.head,
      androidPrefixes: [''], harmonyPrefixes: [''], appId: 'KugouLive', title: 'Synthetic visual difference', profile: '' }
    const before = await verifyHarness(workspace, signal)
    assert.equal(before.status.phase, 'build_passed')
    const review = await prepareNativeReview(workspace, before.status, signal)
    assert.equal(review?.kind, 'visual')
    assert.equal(review?.decision, 'accepted_with_differences')
    assert.ok(review.files.some(file => file.label === 'comparison'))
    const after = await applyNativeReview(workspace, review, { id: 'visual-difference-test', actorId: 'synthetic-human', reason: 'Accept the shown layout and imagery differences for this state', createdAt: new Date() }, signal)
    assert.equal(after.status.nodes.find(node => node.id === 'visual_parity_passed')?.status, 'passed')
    assert.notEqual(after.status.nodes.find(node => node.id === 'device_smoke_passed')?.status, 'passed')
  } finally {
    await rm(root, { recursive: true, force: true })
    if (previousTools === undefined) delete process.env.MIGRATION_HARNESS_DEVECO_TOOLS
    else process.env.MIGRATION_HARNESS_DEVECO_TOOLS = previousTools
  }
})
