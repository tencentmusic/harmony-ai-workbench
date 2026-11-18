import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { harnessRoot, harnessCommand, harnessUiOperationFacts, harnessUiSourceIssues, verifyHarness, type HarnessWorkspace } from './harness'
import { inspectNativeReview, applyNativeReview } from './harness-review'
import { assertUiReviewRecovery, assertUiReviewReconciliation } from './review-recovery-domain'

test('visible UI draft repairs, native visual preflight and stale file checks precede human approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-ui-candidate-'))
  const signal = AbortSignal.timeout(180000)
  const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp()
old=c.run_dir; c.run_dir=c.root/'artifacts'/'harness'; c.run_dir.parent.mkdir(); old.rename(c.run_dir)
m=c.read('manifest'); m['artifact_root']=str(c.run_dir.parent.resolve()); m['harness_run_dir']=str(c.run_dir.resolve()); c.write('manifest',m)
c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved()
p=c.read('parity'); ui=p['ui_review']; p['ui_review']=f.HARNESS.parity_template()['ui_review']; c.write('parity',p)
m=c.read('manifest'); print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':m,'ui':ui}))
c.temporary._finalizer.detach()`
  try {
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'synthetic-ui', continuous: true, materialVersion: 1, artifactRoot: fixture.manifest.artifact_root,
      runDir: fixture.run, androidRoot: fixture.android, harmonyRoot: fixture.harmony, branch: fixture.manifest.harmony.branch, baseSha: fixture.manifest.harmony.head,
      androidPrefixes: [''], harmonyPrefixes: [''], appId: 'fixture', title: 'SYNTHETIC UI TEST', profile: path.join(fixture.root, 'profile.md') }
    const scope = await verifyHarness(workspace, signal, 'scope_approved')
    assert.equal(scope.raw.verified, true)
    const folder = path.join(workspace.artifactRoot, 'candidates')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'ui-review.json')
    await writeFile(file, JSON.stringify({ status: 'incomplete_candidate', summary: 'Real failure shape' }))
    assert.equal((await inspectNativeReview(workspace, scope.status, signal)).review, null)
    const candidate: Record<string, unknown> = { status: 'ready', decision: 'approved', summary: 'SYNTHETIC UI: request human approval', baselines: {}, prototypes: {}, prototypeRenders: {}, androidSources: {}, androidEvidence: {} }
    const roles: Record<string, string> = { layout_spec: 'layoutSpec', visual_regions: 'visualRegions', android_baseline: 'baselines', prototype: 'prototypes', prototype_render: 'prototypeRenders' }
    for (const artifact of fixture.ui.artifacts) {
      const key = roles[artifact.role]
      if (!key) continue
      const relative = `candidates/${artifact.role}-${artifact.state_id || 'all'}${path.extname(artifact.path)}`
      await copyFile(artifact.path, path.join(workspace.artifactRoot, relative))
      if (['layoutSpec', 'visualRegions'].includes(key)) candidate[key] = relative
      else (candidate[key] as Record<string, unknown>)[artifact.state_id] = relative
    }
    const sources = candidate.androidSources as Record<string, unknown>, evidence = candidate.androidEvidence as Record<string, unknown>
    for (const source of fixture.ui.android_sources) {
      sources[source.role] = path.relative(workspace.androidRoot, source.path).replaceAll('\\', '/')
      evidence[source.role] = source.evidence_ids[0]
    }
    await writeFile(file, JSON.stringify({ ...candidate, layoutSpec: 'candidates/missing.md' }))
    assert.match((await inspectNativeReview(workspace, scope.status, signal)).issues.join(''), /不存在/)
    await writeFile(file, JSON.stringify({ ...candidate, layoutSpec: '../private.md' }))
    assert.match((await inspectNativeReview(workspace, scope.status, signal)).issues.join(''), /范围/)
    await writeFile(file, JSON.stringify(candidate))
    const ready = await inspectNativeReview(workspace, scope.status, signal)
    assert.deepEqual(ready.issues, [])
    assert.equal(ready.review?.kind, 'ui')
    const outside = path.join(root, 'other-task-layout.md')
    await copyFile(ready.review!.uiArgs[1], outside)
    const outsideArgs = [...ready.review!.uiArgs]
    outsideArgs[1] = outside
    assert.match((await harnessUiSourceIssues(workspace, outsideArgs, signal)).join(''), /must live/)
    assert.equal((await verifyHarness(workspace, signal, 'ui_prototype_approved')).raw.verified, false)
    const regionsPath = path.join(workspace.artifactRoot, String(candidate.visualRegions))
    const original = await readFile(regionsPath, 'utf8')
    const changed = JSON.parse(original)
    changed.states.live.frame_metadata.theme = 'wrong-theme'
    await writeFile(regionsPath, JSON.stringify(changed))
    assert.match((await inspectNativeReview(workspace, scope.status, signal)).issues.join(''), /frame_metadata_mismatch/)
    await assert.rejects(applyNativeReview(workspace, ready.review!, { id: 'stale-ui', actorId: 'fixture-human', reason: 'SYNTHETIC ONLY', createdAt: new Date() }, signal))
    await writeFile(regionsPath, original)
    const failedOperation = 'synthetic-ui-ui'
    await assert.rejects(harnessCommand(['review-ui', '--run-dir', workspace.runDir, '--operation-id', failedOperation, '--decision', 'approved', '--reviewer', 'fixture-human', '--basis', 'SYNTHETIC FAILURE ONLY', '--approval-reference', 'fixture-user', '--approval-evidence', regionsPath, ...outsideArgs], signal), /must live/)
    assertUiReviewRecovery(await harnessUiOperationFacts(workspace, failedOperation, signal), failedOperation)
    const recoveryOperation = 'synthetic-ui-ui-recovery'
    const human = { id: 'synthetic-ui', operationId: recoveryOperation, actorId: 'fixture-human', reason: 'SYNTHETIC TEST ONLY: explicit UI approval', createdAt: new Date() }
    const reference = `cloud-agent:${workspace.identity}:approval:${human.id}`
    const approvalRoot = path.join(workspace.artifactRoot, 'approvals', human.id)
    await mkdir(approvalRoot, { recursive: true })
    const evidencePath = path.join(approvalRoot, 'human.txt')
    await writeFile(evidencePath, JSON.stringify({ reference, actorId: human.actorId, decidedAt: human.createdAt.toISOString(), decision: ready.review!.decision,
      kind: ready.review!.kind, digest: ready.review!.digest, reason: human.reason }, null, 2))
    await writeFile(path.join(approvalRoot, 'presented.md'), ready.review!.content)
    const interrupted = `import sys,runpy,json
from unittest import mock
api=runpy.run_path(sys.argv[1]); args=api['build_parser']().parse_args(json.loads(sys.argv[2]))
with mock.patch.object(api['contract']('runtime'),'save_outcome',side_effect=FileNotFoundError('synthetic long-path outcome failure')):
 try: args.handler(args)
 except FileNotFoundError: print('synthetic interrupted approval persisted')
 else: raise AssertionError('must simulate interrupted outcome')`
    const cliArgs = ['review-ui', '--run-dir', workspace.runDir, '--operation-id', recoveryOperation, '--decision', ready.review!.decision, '--reviewer', human.actorId,
      '--basis', human.reason, '--approval-reference', reference, '--approval-evidence', evidencePath, ...ready.review!.uiArgs]
    execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-B', '-c', interrupted,
      path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), JSON.stringify(cliArgs)], { encoding: 'utf8', windowsHide: true })
    assertUiReviewReconciliation(await harnessUiOperationFacts(workspace, recoveryOperation, signal), recoveryOperation,
      { reference, actorId: human.actorId, reason: human.reason, decision: 'approved' })
    const originalParity = await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')
    const approved = await applyNativeReview(workspace, ready.review!, { ...human, reconcile: true }, signal)
    assert.equal(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8'), originalParity)
    assert.equal(approved.raw.verified, true, JSON.stringify(approved.status.blockers))
    assert.equal(approved.status.phase, 'ui_prototype_approved')
    const receipt = await harnessUiOperationFacts(workspace, recoveryOperation, signal) as { operation: { status: string } }
    assert.equal(receipt.operation.status, 'committed')
    await assert.rejects(applyNativeReview(workspace, ready.review!, { ...human, reconcile: true }, signal), /不能恢复未知操作或重复批准/)
    assert.throws(() => assertUiReviewRecovery(receipt, recoveryOperation), /已变化/)
    await writeFile(regionsPath, original + '\n')
    const changedApproval = await verifyHarness(workspace, signal, 'ui_prototype_approved')
    assert.equal(changedApproval.raw.verified, false)
    assert.ok(changedApproval.status.blockers.some(item => item.code === 'ui_review_artifact_changed'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
