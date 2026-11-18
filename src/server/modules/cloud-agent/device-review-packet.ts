import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { checkedEvidence } from './device-evidence'
import { deviceReviewContent, nodeTable } from './device-review-content'
import { scenarioRows } from './device-plan'
import { CloudError, record } from './domain'
import { relativeToRoot, sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'

export const DEVICE_REVIEW_POLICY = 'case-evidence-v2'
type Ref = { path: string; sha256: string }
export type DeviceReviewPacket = {
  caseId: string; scenarioId: string; fingerprint: string; executionHash: string; assertionIds: string[]
  content: Record<string, unknown>; files: Map<string, Ref>; required: string[]
}
export type ReusedDeviceReview = { decision: Record<string, unknown>; report: Ref; reviewer: string }

function nodeContext(nodes: Record<string, unknown>[], bindings: Record<string, unknown>[]) {
  // Keep all matches, including invisible/ambiguous ones; do not select only passing nodes.
  const selected = nodes.filter(node => ['Video', 'XComponent', 'root', 'WindowScene'].includes(String(node.type)) ||
    bindings.some(binding => Object.entries(record(binding.where || {})).length > 0 &&
      Object.entries(record(binding.where)).every(([key, value]) => String(node[key]) === String(value))))
  const hierarchies = selected.map(node => String(node.hierarchy || '')).filter(Boolean)
  const context = nodes.filter(node => selected.includes(node) || typeof node.hierarchy === 'string' &&
    hierarchies.some(hierarchy => hierarchy.startsWith(`${node.hierarchy},`)))
  return { selection: 'All binding matches, video surfaces, root windows and ancestors; unrelated nodes remain available in the original layout.',
    total_nodes: nodes.length, omitted_nodes: nodes.length - context.length,
    node_table: nodeTable(context) }
}

export async function buildDeviceReviewPackets(workspace: HarnessWorkspace, manifest: Record<string, unknown>, parity: Record<string, unknown>, verification: Record<string, unknown>, model: string) {
  const cases = scenarioRows(record(verification.functional).cases), scenarios = scenarioRows(parity.scenarios)
  if (!cases.length || new Set(cases.map(row => row.id)).size !== cases.length) throw new CloudError('设备复核用例缺失或重复', 409)
  const packets: DeviceReviewPacket[] = []
  for (const item of cases) {
    const scenario = scenarios.find(row => row.id === item.scenario_id)
    if (!scenario) throw new CloudError('设备复核场景不存在', 409)
    const files = new Map<string, Ref>(), required = new Set<string>()
    const add = async (ref: unknown) => {
      const checked = await checkedEvidence(workspace, ref)
      const relative = await relativeToRoot(workspace.artifactRoot, checked.path)
      files.set(relative, { path: checked.path, sha256: checked.sha256 })
      if (/\.(png|jpe?g|webp)$/i.test(relative)) required.add(relative)
      return checked
    }
    const executionFile = await add(item.execution), execution = record(JSON.parse(executionFile.bytes.toString()))
    const fixture = record(JSON.parse((await add(record(scenario.fixture).artifact)).bytes.toString()))
    const observations = new Map<string, unknown>(), receipts = new Map<string, unknown>()
    const observationRefs = [...scenarioRows(execution.actions).flatMap(action => scenarioRows(action.evidence)),
      ...scenarioRows(execution.intermediate_observations || []), ...scenarioRows(execution.assertions).map(assertion => record(assertion.observation))]
    for (const ref of observationRefs) {
      if (observations.has(String(ref.path))) continue
      const checked = await add(ref), observation = record(JSON.parse(checked.bytes.toString()))
      const provenance = record(observation.provenance || {}), data = record(observation.data || {})
      for (const source of Object.values(provenance)) await add(source)
      if (provenance.receipt && !receipts.has(String(record(provenance.receipt).path))) {
        const rawFile = await add(provenance.receipt), raw = record(JSON.parse(rawFile.bytes.toString()))
        // Include every intermediate native snapshot, not just the final assertable app frame.
        for (const snapshot of scenarioRows(raw.observations || [])) for (const key of ['layout', 'screenshot']) if (snapshot[key]) await add(snapshot[key])
        receipts.set(rawFile.path, { source: provenance.receipt, receipt: JSON.parse(deviceReviewContent(rawFile.bytes.toString()).text) })
      }
      const action = scenarioRows(record(execution.plan || {}).actions || []).find(row => row.id === observation.action_id)
      const { nodes, ...values } = data
      const compact = Array.isArray(nodes) && provenance.layout
        ? { ...observation, data: { ...values, node_context: nodeContext(scenarioRows(nodes), scenarioRows(action?.bindings || [])), nodes_reference: provenance.layout } }
        : JSON.parse(deviceReviewContent(checked.bytes.toString()).text)
      observations.set(checked.path, { source: ref, observation: compact })
    }
    const { tested_at: _tested, room: _rooms, ...environment } = record(record(verification.device).environment || {})
    const fingerprint = sha256(JSON.stringify({ policy: DEVICE_REVIEW_POLICY, identity: workspace.identity, model,
      run: manifest.run_id, implementer: manifest.implementation_actor_id, application: manifest.application,
      build: verification.build, environment, scenario, case: item,
      files: [...files].sort(([a], [b]) => a.localeCompare(b)) }))
    packets.push({ caseId: String(item.id), scenarioId: String(scenario.id), executionHash: executionFile.sha256,
      assertionIds: scenarioRows(scenario.assertions).map(row => String(row.id)).sort(), fingerprint, files, required: [...required],
      content: { policy: DEVICE_REVIEW_POLICY, run_id: manifest.run_id, implementer_id: manifest.implementation_actor_id || 'cloud-agent-implementation', source_snapshot: record(verification.build).source_snapshot,
        scenario, case: item, fixture, execution, observations: [...observations.values()], receipts: [...receipts.values()],
        original_files: [...files.keys()], required_images: [...required],
        review_boundary: 'Inspect every action, assertion and image. Selected UI nodes are context, not a complete tree. Expand original layouts when identity, visibility, navigation, obstruction or an assertion is uncertain. No inferred pass from schema validity.' } })
  }
  return packets
}

export async function readReviewCache(workspace: HarnessWorkspace, packets: DeviceReviewPacket[]) {
  const file = path.join(workspace.artifactRoot, 'device-review/results.json')
  const saved = record(JSON.parse(await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error })))
  const result = new Map<string, ReusedDeviceReview>()
  if (saved.policy !== DEVICE_REVIEW_POLICY || saved.identity !== workspace.identity) return result
  const entries = record(saved.entries || {})
  for (const packet of packets) {
    const entry = record(entries[packet.caseId] || {})
    if (entry.fingerprint !== packet.fingerprint) continue
    const checked = await checkedEvidence(workspace, entry.report), report = record(JSON.parse(checked.bytes.toString()))
    const decision = scenarioRows(report.case_evidence).find(row => row.case_id === packet.caseId)
    if (report.record_type !== 'independent_review' || report.run_id !== packet.content.run_id ||
      JSON.stringify(report.source_snapshot) !== JSON.stringify(packet.content.source_snapshot) || report.implementer_id !== packet.content.implementer_id ||
      !report.reviewer_id || report.reviewer_id === report.implementer_id ||
      record(report.case_fingerprints || {})[packet.caseId] !== packet.fingerprint ||
      !decision || decision.decision !== 'passed' || decision.execution_sha256 !== packet.executionHash || decision.scenario_id !== packet.scenarioId ||
      !Array.isArray(decision.assertion_ids) || JSON.stringify([...decision.assertion_ids].sort()) !== JSON.stringify(packet.assertionIds) ||
      typeof decision.basis !== 'string' || !decision.basis.trim()) continue
    result.set(packet.caseId, { decision, report: { path: checked.path, sha256: checked.sha256 }, reviewer: String(report.reviewer_id) })
  }
  return result
}

export async function saveReviewCache(workspace: HarnessWorkspace, packets: DeviceReviewPacket[], report: Ref) {
  const folder = path.join(workspace.artifactRoot, 'device-review')
  await mkdir(folder, { recursive: true })
  const temporary = path.join(folder, `results-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify({ policy: DEVICE_REVIEW_POLICY, identity: workspace.identity,
    entries: Object.fromEntries(packets.map(packet => [packet.caseId, { fingerprint: packet.fingerprint, report }])) }), { flag: 'wx' })
  await rename(temporary, path.join(folder, 'results.json'))
}
