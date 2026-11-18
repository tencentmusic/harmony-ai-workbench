import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { immutableJson } from './device-evidence'
import type { HarnessWorkspace } from './harness'
import { buildDeviceReviewPackets, readReviewCache, saveReviewCache } from './device-review-packet'

test('case packets preserve actions, observations and conflicts without requiring unrelated tree pages', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'device-packet-test-'))
  try {
    const workspace = { artifactRoot, identity: 'SYNTHETIC' } as HarnessWorkspace
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `irrelevant-${i}`, text: `Unrelated ${i}`, hierarchy: `ROOT,1,${i}`, type: 'Text' }))
    nodes.push({ id: 'video', text: '', hierarchy: 'ROOT,0,0', type: 'XComponent' }, { id: 'video', text: 'duplicate', hierarchy: 'ROOT,0,1', type: 'XComponent' }, { id: 'root', text: '', hierarchy: 'ROOT', type: 'root' })
    const layout = await immutableJson(path.join(artifactRoot, 'layout.json'), { nodes })
    const screenshot = await immutableJson(path.join(artifactRoot, 'screenshot.json'), { synthetic: 'image placeholder' })
    const raw = await immutableJson(path.join(artifactRoot, 'raw.json'), { action: { kind: 'home' }, commands: [{ argv: ['SYNTHETIC', 'Home'], exit_code: 0 }], observations: [{ nodes, layout, screenshot }] })
    const observation = await immutableJson(path.join(artifactRoot, 'observation.json'), { action_id: 'A', foreground_bundle: 'system.desktop', data: { nodes, value: true, surface_motion: { real_metric: 0.5 } }, provenance: { receipt: raw, layout, screenshot } })
    const fixture = await immutableJson(path.join(artifactRoot, 'fixture.json'), { synthetic: true })
    const execution = await immutableJson(path.join(artifactRoot, 'execution.json'), { actions: [{ id: 'A', evidence: [observation] }], assertions: [{ id: 'X', observation }], intermediate_observations: [observation], plan: { actions: [{ id: 'A', bindings: [{ assertionId: 'X', where: { id: 'video' } }] }] } })
    const manifest = { run_id: 'run', implementation_actor_id: 'implementer' }
    const scenario = { id: 'S', actions: [{ id: 'A', target: 'video' }], assertions: [{ id: 'X', action_id: 'A', selector: 'value', expected: true }], fixture: { artifact: fixture } }
    const verification = { build: { source_snapshot: 'source', artifact_sha256: 'package' }, device: { environment: { device: 'test' } }, functional: { cases: [{ id: 'F', scenario_id: 'S', execution }] } }
    const packets = await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario] }, verification, 'model')
    const packet = packets[0]
    const encoded = JSON.stringify(packet.content)
    assert.ok(encoded.length < JSON.stringify(nodes).length / 2)
    assert.match(encoded, /duplicate/)
    assert.match(encoded, /system.desktop/)
    assert.match(encoded, /real_metric/)
    assert.match(encoded, /Home/)
    assert.match(encoded, /omitted_nodes/)
    assert.equal(packet.files.size, 6)
    assert.ok(!packet.required.includes('layout.json'))
    assert.ok(packet.files.has('layout.json'))
    assert.deepEqual(packet.content.scenario, scenario)
    const unchanged = await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario] }, verification, 'model')
    assert.equal(packet.fingerprint, unchanged[0].fingerprint)
    for (const changed of [
      { ...verification, build: { ...verification.build, artifact_sha256: 'new-package' } },
      { ...verification, build: { ...verification.build, source_snapshot: 'new-source' } },
    ]) assert.notEqual(packet.fingerprint, (await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario] }, changed, 'model'))[0].fingerprint)
    assert.notEqual(packet.fingerprint, (await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario] }, verification, 'other-model'))[0].fingerprint)
    const reportData = { record_type: 'independent_review', reviewer_id: 'reviewer', implementer_id: 'implementer', run_id: 'run', source_snapshot: 'source', case_fingerprints: { F: packet.fingerprint }, case_evidence: [{ case_id: 'F', scenario_id: 'S', execution_sha256: execution.sha256, assertion_ids: ['X'], decision: 'passed', basis: 'SYNTHETIC ONLY' }] }
    const report = await immutableJson(path.join(artifactRoot, 'report.json'), reportData)
    await saveReviewCache(workspace, packets, report)
    assert.equal((await readReviewCache(workspace, packets)).size, 1)
    assert.equal((await readReviewCache(workspace, [{ ...packet, fingerprint: 'changed' }])).size, 0)
    const secondScenario = { ...scenario, id: 'S2' }
    const twoCases = { ...verification, functional: { cases: [...verification.functional.cases, { ...verification.functional.cases[0], id: 'F2', scenario_id: 'S2' }] } }
    const both = await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario, secondScenario] }, twoCases, 'model')
    assert.equal(both[0].fingerprint, packet.fingerprint, 'Adding another case must not invalidate unchanged case')
    const bothReport = await immutableJson(path.join(artifactRoot, 'both-report.json'), { ...reportData,
      case_fingerprints: Object.fromEntries(both.map(p => [p.caseId, p.fingerprint])),
      case_evidence: [...reportData.case_evidence, { ...reportData.case_evidence[0], case_id: 'F2', scenario_id: 'S2', decision: 'failed' }] })
    await saveReviewCache(workspace, both, bothReport)
    assert.deepEqual([...(await readReviewCache(workspace, both)).keys()], ['F'], 'failed cases are never skipped')
    const changedCases = await buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario, { ...secondScenario, actions: [{ id: 'A', target: 'changed' }] }] }, twoCases, 'model')
    assert.equal(changedCases[0].fingerprint, both[0].fingerprint)
    assert.notEqual(changedCases[1].fingerprint, both[1].fingerprint)
    await saveReviewCache(workspace, packets, report)
    await writeFile(report.path, '{}')
    await assert.rejects(readReviewCache(workspace, packets), /摘要/)
    await writeFile(layout.path, '{}')
    await assert.rejects(buildDeviceReviewPackets(workspace, manifest, { scenarios: [scenario] }, verification, 'model'), /摘要/)
  } finally { await rm(artifactRoot, { recursive: true, force: true }) }
})
