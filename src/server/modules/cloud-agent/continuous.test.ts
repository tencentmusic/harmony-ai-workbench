import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HARNESS_PHASES, HARNESS_STAGE, cloudStageForHarness } from '@/contracts/cloud-agent'
import { projectHarnessStatus } from './harness-domain'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { harnessRoot, harnessCommand, harnessReviewFacts, verifyHarness, executionTools, type HarnessWorkspace } from './harness'
import { prepareNativeReview, inspectNativeReview, applyNativeReview } from './harness-review'
import { acceptanceTools } from './acceptance-tools'
import { codeReviewTool, inspectCodeReview, requireCodeReview } from './code-review'
import { CODE_CHECKS } from './code-review-domain'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTaskTools } from './task-tools'
import { sha256 } from './scoped-files'
import { invokeRuntime } from './native-runtime'

test('record-change source self-audit unlocks wired only with fresh complete native proofs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-wiring-'))
  const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp(); c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved(); c.mark_implemented(); c.mark_wired()
t=c.read('traceability'); t['skeleton_audit']['status']='pending'; c.write('traceability',t)
m=c.read('manifest'); print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':m}))
c.temporary._finalizer.detach()`
  const signal = AbortSignal.timeout(180000)
  try {
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'synthetic-wiring', continuous: true, materialVersion: 1, artifactRoot: fixture.manifest.artifact_root,
      runDir: fixture.run, androidRoot: fixture.android, harmonyRoot: fixture.harmony, branch: fixture.manifest.harmony.branch, baseSha: fixture.manifest.harmony.head,
      androidPrefixes: [''], harmonyPrefixes: [''], appId: 'fixture', title: 'Synthetic wiring', profile: path.join(fixture.root, 'profile.md') }
    const approvals = await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8')
    assert.equal((await verifyHarness(workspace, signal)).status.phase, 'implemented')
    const tools = await executionTools(workspace, signal, async () => {})
    const writer = tools.find(tool => tool.definition.name === 'harness_record')!
    const payload = JSON.parse(await readFile(path.join(workspace.runDir, 'traceability-map.json'), 'utf8'))
    for (const chain of payload.reachability) for (const proof of Object.values(chain.proof)) {
      const item = proof as { path: string }
      item.path = path.relative(workspace.harmonyRoot, item.path).replaceAll('\\', '/')
    }
    payload.skeleton_audit = { ...payload.skeleton_audit, status: 'passed', notes: 'SYNTHETIC: inspected every source chain' }
    const incomplete = structuredClone(payload)
    delete incomplete.reachability[0].proof.cleanup
    await writer.call({ command: 'record-change', operationId: 'missing-proof', payload: incomplete })
    assert.equal((await verifyHarness(workspace, signal, 'wired')).raw.verified, false)
    const stale = structuredClone(payload)
    stale.reachability[0].proof.cleanup.sha256 = '0'.repeat(64)
    await writer.call({ command: 'record-change', operationId: 'stale-proof', payload: stale })
    assert.equal((await verifyHarness(workspace, signal, 'wired')).raw.verified, false)
    await writer.call({ command: 'record-change', operationId: 'complete-proof', payload })
    const checked = await verifyHarness(workspace, signal, 'wired')
    assert.equal(checked.raw.verified, true, JSON.stringify(checked.raw))
    assert.equal(checked.status.phase, 'wired')
    await assert.rejects(requireCodeReview(workspace, signal), /代码审查未通过/)
    assert.equal(await readFile(path.join(workspace.runDir, 'parity-matrix.json'), 'utf8'), approvals)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('synthetic device receipts require human visual approval before native four-document finalize', async () => {
  const previousTools = process.env.MIGRATION_HARNESS_DEVECO_TOOLS
  process.env.MIGRATION_HARNESS_DEVECO_TOOLS = JSON.stringify([path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests/fixtures')])
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-visual-'))
  const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp()
m=c.read('manifest'); m['android_entry']=str(c.android / 'EntryFragment.java'); c.write('manifest',m)
c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved(); c.mark_implemented(); c.mark_wired(); c.mark_build(); c.mark_device(); c.mark_visual(); c.mark_functional()
v=c.read('verification'); v['visual']['states'][0]['human_review']=None; c.write('verification',v)
m=c.read('manifest'); print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':m}))
c.temporary._finalizer.detach()`
  // The full native approval/review/finalize chain needs headroom for Windows process startup.
  const signal = AbortSignal.timeout(300000)
  try {
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'synthetic-visual', continuous: true, materialVersion: 1, artifactRoot: fixture.manifest.artifact_root,
      runDir: fixture.run, androidRoot: fixture.android, harmonyRoot: fixture.harmony, branch: fixture.manifest.harmony.branch, baseSha: fixture.manifest.harmony.head,
      androidPrefixes: [''], harmonyPrefixes: [''], appId: 'KugouLive', title: 'Synthetic visual test', profile: path.join(fixture.root, 'profile.md') }
    const before = await verifyHarness(workspace, signal, 'delivery_ready')
    assert.equal(before.raw.verified, false)
    const review = await prepareNativeReview(workspace, before.status, signal)
    assert.equal(review?.kind, 'visual', JSON.stringify({ before: before.raw, visual: JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')).visual }))
    assert.ok(review!.files.some(file => file.label === 'harmony'))
    await assert.rejects(applyNativeReview(workspace, { ...review!, digest: '0'.repeat(64) }, { id: 'stale', actorId: 'synthetic-human', reason: 'fixture', createdAt: new Date() }, signal), /变化/)
    const approved = await applyNativeReview(workspace, review!, { id: 'synthetic-visual-approval', actorId: 'synthetic-human', reason: 'SYNTHETIC TEST ONLY: approve visual fixture', createdAt: new Date() }, signal)
    assert.equal(approved.raw.verified, true)
    await assert.rejects(requireCodeReview(workspace, signal), /代码审查未通过/)
    const writer = await executionTools(workspace, signal, async () => {})
    await assert.rejects(writer.find(tool => tool.definition.name === 'harness_record')!.call({ command: 'record-static', operationId: 'forged-review', payload: { status: 'passed' } }), /独立审查/)
    const reviewTool = codeReviewTool(workspace, 'synthetic', signal, async () => {}, async () => {}, async input => {
      assert.match(input.prompt, /构建前静态审查/)
      assert.match(input.prompt, /不得仅因后续证据尚未产生而阻塞/)
      assert.match(input.prompt, /源码或业务依据确实不足仍记 blocked/)
      const client = new Client({ name: 'synthetic-reviewer', version: '1.0.0' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(input.taskMcp!.url), { requestInit: { headers: input.taskMcp!.headers } }))
        const tools = (await client.listTools()).tools.map(tool => tool.name)
        assert.ok(tools.includes('review_read_batch'))
        assert.ok(!['source_write', 'source_edit', 'source_delete', 'source_move', 'harness_record', 'harness_start'].some(name => tools.includes(name)))
        const response = await client.callTool({ name: 'review_diff' })
        const text = (response.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text
        const files = JSON.parse(text).files as string[]
        const context = JSON.parse(text) as { androidEntry: string; ledgers: string[] }
        const readAll = async (name: string, args: Record<string, unknown>) => {
          let offset: number | null = 0
          while (offset !== null) {
            const result = await client.callTool({ name, arguments: { ...args, offset } })
            assert.ok(!result.isError)
            offset = JSON.parse((result.content as { text: string }[])[0].text).nextOffset
          }
        }
        await readAll('harness_rule', { path: 'START_HERE.md' })
        for (const file of context.ledgers) await readAll('artifact_read', { path: file })
        for (const file of files) await client.callTool({ name: 'source_read', arguments: { platform: 'harmony', path: file } })
        const report = JSON.stringify({ summary: 'SYNTHETIC TEST ONLY: independent static audit', reviewedFiles: [...files, context.androidEntry, ...context.ledgers], checks: CODE_CHECKS.map(id => ({ id, status: 'passed', evidence: 'Synthetic fixture source inspection' })), findings: [] })
        assert.ok(input.onTurnComplete, 'independent reviewer must repair coverage before closing its session')
        const continuation = await input.onTurnComplete(report)
        assert.match(continuation!, /source_read/)
        assert.ok(continuation!.includes(context.androidEntry))
        const batch = await client.callTool({ name: 'review_read_batch' })
        assert.ok(!batch.isError)
        assert.deepEqual(JSON.parse((batch.content as { text: string }[])[0].text).pendingReads, [])
        assert.equal(await input.onTurnComplete(report), null)
        return report
      } finally { await client.close() }
    })
    await reviewTool.call({})
    const inspected = await inspectCodeReview(workspace, signal)
    assert.equal(inspected.status, 'passed')
    assert.ok(Date.parse(inspected.completedAt!) >= Date.parse(inspected.startedAt!))
    assert.ok(inspected.roundElapsedMs! > 0)
    // Exercise the real acceptance sidecar and closeout, not only the legacy finalize path.
    await invokeRuntime(workspace, 'acceptance', { kind: 'configure' }, 'synthetic-configure', signal)
    const proofPath = path.join(workspace.artifactRoot, 'synthetic-normal-start.txt')
    const proof = 'SYNTHETIC OFFLINE TEST: fixture normal start and default configuration only'
    await writeFile(proofPath, proof)
    for (const item of ['normal_start', 'configuration']) await invokeRuntime(workspace, 'acceptance', {
      kind: 'closeout', item, status: 'done', reason: proof, evidence: [{ path: proofPath, sha256: sha256(proof) }],
      location: 'fixture/Config.ets', default_value: 'true', normal_entry: 'home', debug_override: false,
    }, `synthetic-${item}`, signal)
    const execution = await acceptanceTools(workspace, signal, async () => {})
    try { await execution.tools.find(tool => tool.definition.name === 'harness_finalize')!.call({ operationId: 'synthetic-finalize' }) } finally { await execution.close() }
    const final = await verifyHarness(workspace, signal, 'delivery_ready')
    assert.equal(final.raw.verified, true, JSON.stringify(final.status.blockers))
    const verification = JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8'))
    assert.equal(verification.delivery.documents.length, 4)
    const source = path.join(workspace.harmonyRoot, 'entry.ets')
    await writeFile(source, (await readFile(source, 'utf8')) + '\n// synthetic mutation after review\n')
    assert.equal((await inspectCodeReview(workspace, signal)).status, 'stale')
    await assert.rejects(requireCodeReview(workspace, signal), /重新审查/)
  } finally {
    if (previousTools === undefined) delete process.env.MIGRATION_HARNESS_DEVECO_TOOLS
    else process.env.MIGRATION_HARNESS_DEVECO_TOOLS = previousTools
    await rm(root, { recursive: true, force: true })
  }
})

test('all Harness nodes have one business stage and active gates drive lifecycle', () => {
  assert.equal(Object.keys(HARNESS_STAGE).length, HARNESS_PHASES.length)
  for (const [id] of HARNESS_PHASES) assert.ok(HARNESS_STAGE[id])
  const status = (phase: string) => projectHarnessStatus({ phase, verified: true, gates: {}, blockers: [], next_actions: [] })
  assert.equal(cloudStageForHarness(status('initialized')), 'analysis')
  assert.equal(cloudStageForHarness(status('context_ready')), 'analysis')
  assert.equal(cloudStageForHarness(status('evidence_ready')), 'approval')
  assert.equal(cloudStageForHarness(status('scope_approved')), 'approval')
  assert.equal(cloudStageForHarness(status('ui_prototype_approved')), 'ready')
  assert.equal(cloudStageForHarness(status('implemented')), 'coding')
  assert.equal(cloudStageForHarness(status('wired')), 'review')
  for (const [phase, stage] of [['build_passed', 'device'], ['functional_parity_passed', 'integration'], ['delivery_ready', 'integration']]) {
    assert.equal(cloudStageForHarness({ ...status(phase), codeReview: { status: 'passed', summary: '', checks: [], findings: [] } }), stage)
  }
})

test('native scope and no-UI human approvals advance the same real Harness without an agent signing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-continuous-'))
  const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp(); c.mark_context(); c.mark_evidence(); c.mark_scope()
p=c.read('parity'); p['scope_approval']={'status':'pending','basis':'','approved_at':None}; p['ui_scope']={'status':'not_applicable','basis':'Synthetic protocol-only task with no UI','states':[]}; c.write('parity',p)
e=c.read('evidence'); e['review_package']['presentation']=None; c.write('evidence',e)
m=c.read('manifest'); print(json.dumps({'root':str(c.root.resolve()),'run':str(c.run_dir.resolve()),'android':str(c.android.resolve()),'harmony':str(c.harmony.resolve()),'manifest':m}))
c.temporary._finalizer.detach()`
  const signal = AbortSignal.timeout(240000)
  try {
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const workspace: HarnessWorkspace = { identity: 'synthetic-review', continuous: true, materialVersion: 1, artifactRoot: fixture.manifest.artifact_root,
      runDir: fixture.run, androidRoot: fixture.android, harmonyRoot: fixture.harmony, branch: fixture.manifest.harmony.branch, baseSha: fixture.manifest.harmony.head,
      androidPrefixes: [''], harmonyPrefixes: [''], appId: 'fixture', title: 'Synthetic review', profile: path.join(fixture.root, 'profile.md') }
    const before = await verifyHarness(workspace, signal)
    assert.equal(before.status.phase, 'evidence_ready')
    const parityPath = path.join(workspace.runDir, 'parity-matrix.json')
    const originalParity = await readFile(parityPath, 'utf8')
    const incomplete = JSON.parse(originalParity)
    delete incomplete.items[0].android_behavior
    await writeFile(parityPath, JSON.stringify(incomplete))
    const invalid = await verifyHarness(workspace, signal)
    assert.ok(invalid.status.blockers.some(issue => issue.code === 'parity_required_field_missing'))
    assert.equal(await prepareNativeReview(workspace, invalid.status, signal), null, 'incomplete facts cannot enter approval')
    await writeFile(parityPath, originalParity)
    const review = await prepareNativeReview(workspace, before.status, signal)
    assert.equal(review?.kind, 'scope')
    const readOnly = await executionTools(workspace, signal, async () => {}, false)
    assert.ok(!readOnly.some(tool => ['source_write', 'source_edit', 'source_delete', 'source_move'].includes(tool.definition.name)))
    await assert.rejects(readOnly.find(tool => tool.definition.name === 'harness_record')!.call({ command: 'record-change', operationId: 'forged', payload: {} }), /非法/)
    const sameRun = JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')).run_id
    await assert.rejects(applyNativeReview(workspace, { ...review!, digest: '0'.repeat(64) }, { id: 'stale', actorId: 'fixture-human', reason: 'synthetic approval', createdAt: new Date() }, signal), /变化/)
    const scope = await applyNativeReview(workspace, review!, { id: 'scope-1', actorId: 'fixture-human', reason: 'SYNTHETIC TEST ONLY: approve shown scope', createdAt: new Date() }, signal)
    assert.equal(scope.raw.verified, true, JSON.stringify(scope.status.blockers))
    assert.equal(scope.status.phase, 'scope_approved')
    const approvedParity = JSON.parse(await readFile(parityPath, 'utf8'))
    const omitted = { ...approvedParity }
    delete omitted.scope_approval
    delete omitted.ui_review
    const writer = readOnly.find(tool => tool.definition.name === 'harness_record')!
    await writer.call({ command: 'record-parity', operationId: 'omit-decisions', payload: omitted })
    assert.deepEqual(JSON.parse(await readFile(parityPath, 'utf8')), approvedParity)
    await assert.rejects(writer.call({ command: 'record-context', section: 'application', operationId: 'nested-decision', payload: { ui_review: approvedParity.ui_review } }), /人工批准/)
    const manifestPath = path.join(workspace.runDir, 'manifest.json')
    const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writer.call({ command: 'record-context', section: 'application', operationId: 'keep-section', payload: originalManifest.application })
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), originalManifest)
    // Reproduce the historical omission only in the isolated native fixture.
    const missingUi = { ...approvedParity }
    delete missingUi.ui_review
    await writeFile(parityPath, JSON.stringify(missingUi))
    const broken = await verifyHarness(workspace, signal, 'scope_approved')
    assert.equal(broken.raw.verified, false)
    assert.ok(broken.status.blockers.some(issue => issue.code === 'ui_review_missing'))
    assert.equal(await prepareNativeReview(workspace, broken.status, signal), null)
    const digestBefore = (await harnessReviewFacts(workspace, signal)).digest
    const restoreFile = path.join(root, 'restore-pending-ui.json')
    await writeFile(restoreFile, JSON.stringify(approvedParity))
    await harnessCommand(['record-parity', '--run-dir', workspace.runDir, '--operation-id', 'restore-pending-ui', '--input', restoreFile], signal)
    assert.equal((await harnessReviewFacts(workspace, signal)).digest, digestBefore)
    assert.deepEqual(JSON.parse(await readFile(parityPath, 'utf8')).scope_approval, approvedParity.scope_approval)
    assert.equal((await verifyHarness(workspace, signal, 'scope_approved')).raw.verified, true)
    assert.equal((await verifyHarness(workspace, signal, 'ui_prototype_approved')).raw.verified, false)
    const corrected = JSON.parse(await readFile(parityPath, 'utf8'))
    corrected.items[0].behavior += ' (clarified scope)'
    await writeFile(parityPath, JSON.stringify(corrected))
    const evidencePath = path.join(workspace.runDir, 'evidence-ledger.json')
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    evidence.review_package.presentation = null
    await writeFile(evidencePath, JSON.stringify(evidence))
    const changed = await verifyHarness(workspace, signal)
    assert.ok(changed.status.blockers.some(issue => issue.code === 'review_scope_package_stale'))
    const newReview = await prepareNativeReview(workspace, changed.status, signal)
    assert.equal(newReview?.kind, 'scope', 'changed facts must permit a new human decision')
    assert.notEqual(newReview!.digest, review!.digest)
    const reapproved = await applyNativeReview(workspace, newReview!, { id: 'scope-2', actorId: 'fixture-human', reason: 'SYNTHETIC TEST ONLY: approve corrected scope', createdAt: new Date() }, signal)
    assert.equal(reapproved.raw.verified, true)
    await mkdir(path.join(workspace.artifactRoot, 'candidates'), { recursive: true })
    await writeFile(path.join(workspace.artifactRoot, 'candidates/ui-review.json'), JSON.stringify({ status: 'incomplete_candidate', summary: 'Draft is not a decision', prototypes: {}, prototypeRenders: {} }))
    const draft = await inspectNativeReview(workspace, reapproved.status, signal)
    assert.equal(draft.review, null)
    assert.match(draft.issues.join(' '), /decision.*layoutSpec/)
    await assert.rejects(prepareNativeReview(workspace, reapproved.status, signal), /decision/)
    await writeFile(path.join(workspace.artifactRoot, 'candidates/ui-review.json'), '{')
    const malformed = await inspectNativeReview(workspace, reapproved.status, signal)
    assert.equal(malformed.review, null)
    assert.match(malformed.issues.join(' '), /JSON/)
    await writeFile(path.join(workspace.artifactRoot, 'candidates/ui-review.json'), JSON.stringify({ decision: 'not_applicable', summary: 'Synthetic protocol-only scope, no visible UI.' }))
    const ui = await prepareNativeReview(workspace, reapproved.status, signal)
    assert.equal(ui?.kind, 'ui')
    const result = await applyNativeReview(workspace, ui!, { id: 'ui-1', actorId: 'fixture-human', reason: 'SYNTHETIC TEST ONLY: confirm no visible UI', createdAt: new Date() }, signal)
    assert.equal(result.raw.verified, true, JSON.stringify(result.status.blockers))
    assert.equal(result.status.phase, 'ui_prototype_approved')
    assert.equal(JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8')).run_id, sameRun)
    assert.equal((await prepareNativeReview(workspace, result.status, signal)), null)
    // Real native approvals must unlock whole-project editing, not only the suggested module.
    workspace.harmonyPrefixes = ['suggested-app-only']
    const edits = await executionTools(workspace, signal, async () => {})
    const endpoint = await startTaskTools(edits, signal, async () => {})
    const client = new Client({ name: 'source-editor-fixture', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
      for (let i = 0; i < 81; i++) await writeFile(path.join(workspace.harmonyRoot, `file-${i}.ts`), '// fixture\n')
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args })
        assert.ok(!response.isError, JSON.stringify(response))
        return JSON.parse((response.content as { text: string }[])[0].text)
      }
      await call('source_write', { path: 'shared/player.cpp', content: 'old();\r\n', expectedSha256: 'new' })
      const read = await call('source_read', { platform: 'harmony', path: 'shared/player.cpp' })
      await call('source_edit', { path: 'shared/player.cpp', expectedSha256: read.sha256, edits: [{ oldText: 'old()', newText: 'newCall()' }] })
      assert.equal(await readFile(path.join(workspace.harmonyRoot, 'shared/player.cpp'), 'utf8'), 'newCall();\r\n')
      await call('source_move', { path: 'shared/player.cpp', targetPath: 'common/player.cc', expectedSha256: sha256('newCall();\r\n') })
      await call('source_delete', { path: 'common/player.cc', expectedSha256: sha256('newCall();\r\n') })
      for (const file of ['build-profile.json5', '.gitignore']) {
        const before = await call('source_read', { platform: 'harmony', path: file })
        await call('source_edit', { path: file, expectedSha256: before.sha256, edits: [{ oldText: before.text, newText: `${before.text}\n` }] })
      }
      assert.ok((await call('source_list', { platform: 'harmony', query: '.gitignore' })).files.includes('.gitignore'))
      const wrongBranch = await executionTools({ ...workspace, branch: 'feature/other-task' }, signal, async () => {})
      await assert.rejects(wrongBranch.find(tool => tool.definition.name === 'source_write')!.call({ path: 'forbidden.ts', content: '', expectedSha256: 'new' }), /任务鸿蒙分支已变化/)
      await assert.rejects(edits.find(tool => tool.definition.name === 'source_edit')!.call({ path: '../outside.ets', expectedSha256: 'new', edits: [{ oldText: 'a', newText: 'b' }] }), /范围/)
    } finally { await client.close(); await endpoint.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
