import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { executionTools, harnessRoot, type HarnessWorkspace } from './harness'

test('coding record rejects approved fact and presentation mutations before touching the ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'approved-facts-'))
  try {
    const script = `import sys,json,tempfile
sys.path.insert(0,sys.argv[1])
import test_migration_harness as f
original=tempfile.TemporaryDirectory
tempfile.TemporaryDirectory=lambda: original(dir=sys.argv[2])
c=f.MigrationHarnessTests(); c.setUp(); c.mark_context(); c.mark_evidence(); c.mark_scope(); c.mark_ui_approved()
m=c.read('manifest'); print(json.dumps({'run':str(c.run_dir.resolve()),'manifest':m}))
c.temporary._finalizer.detach()`
    const fixture = JSON.parse(execFileSync(process.env.CLOUD_AGENT_HARNESS_PYTHON || 'python', ['-B', '-c', script, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/tests'), root], { encoding: 'utf8', windowsHide: true }))
    const m = fixture.manifest
    const workspace: HarnessWorkspace = { identity: m.run_id, runDir: fixture.run, artifactRoot: m.artifact_root, androidRoot: m.android.root, harmonyRoot: m.harmony.root, branch: m.harmony.branch, baseSha: m.harmony.head, androidPrefixes: [''], harmonyPrefixes: [''], appId: 'fixture', title: 'Fixture', profile: '' }
    const tools = await executionTools(workspace, AbortSignal.timeout(120000), async () => {}, true)
    const tool = tools.find(item => item.definition.name === 'harness_record')!
    const evidencePath = path.join(workspace.runDir, 'evidence-ledger.json')
    const parityPath = path.join(workspace.runDir, 'parity-matrix.json')
    const originalEvidence = await readFile(evidencePath, 'utf8'), originalParity = await readFile(parityPath, 'utf8')
    const evidence = JSON.parse(originalEvidence), parity = JSON.parse(originalParity)
    const changed = structuredClone(evidence)
    changed.items.find((item: { id: string }) => item.id === changed.review_package.evidence_ids[0]).claim += ' edited after approval'
    await assert.rejects(tool.call({ command: 'record-evidence', payload: changed, operationId: 'tamper-fact' }), /已审/)
    await assert.rejects(tool.call({ command: 'record-evidence', payload: { ...evidence, review_package: { ...evidence.review_package, presentation: null } }, operationId: 'clear-presentation' }), /已审/)
    parity.items[0].behavior += ' changed scope'
    await assert.rejects(tool.call({ command: 'record-parity', payload: parity, operationId: 'tamper-scope' }), /已审/)
    assert.equal(await readFile(evidencePath, 'utf8'), originalEvidence)
    assert.equal(await readFile(parityPath, 'utf8'), originalParity)
    evidence.items.push({ ...evidence.items[0], id: 'E-IMPLEMENTATION-NOTE' })
    await tool.call({ command: 'record-evidence', payload: evidence, operationId: 'add-unreviewed-evidence' })
    assert.equal(JSON.parse(await readFile(evidencePath, 'utf8')).items.length, evidence.items.length)
  } finally { await rm(root, { recursive: true, force: true }) }
})
