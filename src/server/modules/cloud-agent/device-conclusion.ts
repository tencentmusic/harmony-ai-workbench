import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { CloudDeviceConclusion, CloudHarness } from '@/contracts/cloud-agent'
import { CloudError, record } from './domain'
import { sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'

export function canConcludeDevice(status: CloudHarness) {
  return status.codeReview?.status === 'passed' && status.nodes.some(node => node.id === 'build_passed' && node.status === 'passed')
}

export async function deviceConclusion(workspace: HarnessWorkspace, status: CloudHarness, verified: boolean, reason: string): Promise<CloudDeviceConclusion> {
  if (!canConcludeDevice(status)) throw new CloudError('代码审查或构建尚未通过，不能结束设备验收', 409)
  const sourceHeadSha = workspace.harmonyHeadSha ?? workspace.baseSha
  if (!/^[a-f0-9]{40,64}$/.test(sourceHeadSha) || !workspace.materialVersion) throw new CloudError('设备结论缺少当前源码或材料版本', 409)
  const report = await readFile(path.join(workspace.runDir, 'verification-report.json'))
  const build = record(record(JSON.parse(report.toString('utf8'))).build || {})
  const hapSha256 = typeof build.artifact_sha256 === 'string' && /^[a-f0-9]{64}$/.test(build.artifact_sha256) ? build.artifact_sha256 : undefined
  const deviceNodes = status.nodes.filter(node => ['device_smoke_passed', 'visual_parity_passed', 'functional_parity_passed'].includes(node.id))
  const passed = verified && status.phase === 'delivery_ready' && deviceNodes.every(node => node.status === 'passed')
  return {
    result: passed ? 'passed' : 'incomplete', sourceHeadSha, hapSha256,
    materialVersion: workspace.materialVersion, verificationSha256: sha256(report), concludedAt: new Date().toISOString(),
    nodes: deviceNodes, blockers: status.blockers, reason: passed ? 'Harness 严格交付门禁通过' : reason.slice(0, 4000),
  }
}

export async function assertDeviceConclusion(workspace: HarnessWorkspace, conclusion: CloudDeviceConclusion, status: CloudHarness) {
  if (!canConcludeDevice(status) || conclusion.materialVersion !== workspace.materialVersion || conclusion.sourceHeadSha !== (workspace.harmonyHeadSha ?? workspace.baseSha)) throw new CloudError('设备结论与当前代码、材料或构建不一致', 409)
  const report = await readFile(path.join(workspace.runDir, 'verification-report.json'))
  if (sha256(report) !== conclusion.verificationSha256) throw new CloudError('设备验收原始报告已变化，需重新生成结论', 409)
}
