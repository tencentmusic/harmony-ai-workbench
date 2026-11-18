export type CloudStatus = 'queued' | 'running' | 'awaiting_input' | 'awaiting_approval' | 'approved' | 'blocked' | 'cancelling' | 'cancelled' | 'failed' | 'translation_queued' | 'translating' | 'harness_waiting' | 'code_ready' | 'review_queued' | 'reviewing' | 'delivery_ready' | 'device_concluded' | 'delivery_queued' | 'delivering' | 'awaiting_merge' | 'knowledge_review' | 'completed'
export type CloudAction = 'approve' | 'retry' | 'cancel' | 'translate' | 'resume_translation' | 'submit_delivery' | 'confirm_delivery' | 'sync_delivery' | 'publish_knowledge' | 'rework'
export interface CloudHandoff {
  status: 'pending' | 'submitted' | 'closed' | 'missing'
  error?: string
  submittedAt?: string
  submittedBy?: string
}
export interface CloudApp { id: string; label: string; defaultBranch: string; model: string; sourceIssues?: string[] }
export interface CloudAnalysis { summary: string; requirements: string[]; approach: string[]; acceptance: string[]; questions: string[] }
export interface CloudRun {
  kind?: string; harness?: CloudHarness | null
  id: string; status: string; baseSha: string | null; output: string; digest: string | null
  error: string | null; createdAt: string; finishedAt: string | null
  materialVersion: number; materialSnapshot: string; attachments: CloudAttachment[]
}
export interface CloudRunPage { items: CloudRun[]; nextBefore: number | null }
export interface CloudAttachment { id: string; name: string; mime: string; kind: 'document' | 'image' | 'video'; size: number; sha256: string }
export const CLOUD_MATERIAL_ACCEPT = '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm'
export const CLOUD_MATERIAL_COUNT = 10
export const CLOUD_MATERIAL_TOTAL = 200 * 1024 * 1024
export interface CloudTask {
  recoveryRequired?: boolean
  branch?: { name: string; base: string; sha?: string } | null
  delivery?: { codeUrl?: string; knowledgeUrl?: string; integrationId?: string; codeMerged?: boolean; frozen?: boolean; handoff?: CloudHandoff; repositoryUrl?: string; branch?: string; target?: string; acceptedSha?: string; mergedSourceSha?: string; documentsPath?: string }
  stage?: CloudStageId
  review?: CloudReview | null
  approvedReviews?: CloudReview[]
  harness?: CloudHarness | null
  deviceConclusion?: CloudDeviceConclusion
  id: string; appId: string; title: string; material: string; targetBranch: string; model: string
  creatorName?: string | null; owned?: boolean
  source: string; sourceUrl: string | null; status: CloudStatus; revision: number; createdAt: string; updatedAt: string
  runs: CloudRun[]; actions: CloudAction[]
  materialVersion: number; attachments: CloudAttachment[]
}
export interface CloudDeviceConclusion {
  result: 'passed' | 'incomplete'
  sourceHeadSha: string; hapSha256?: string; materialVersion: number; verificationSha256: string; concludedAt: string
  nodes: CloudHarness['nodes']; blockers: CloudHarness['blockers']; reason: string
}
export interface CloudEvent { id: number; taskId: string; runId: string | null; kind: string; message: string; createdAt: string }

export const CLOUD_STAGES = [
  { id: 'preparation', label: '材料准备', enabled: true, statuses: ['queued', 'awaiting_input'] },
  { id: 'analysis', label: '需求分析', enabled: true, statuses: ['running', 'blocked', 'failed', 'cancelling'] },
  { id: 'approval', label: '人工审批', enabled: true, statuses: ['awaiting_approval', 'review_queued', 'reviewing'] },
  { id: 'ready', label: '待转译', enabled: true, statuses: ['approved'] },
  { id: 'coding', label: '代码转译', enabled: true, statuses: ['translation_queued', 'translating', 'harness_waiting', 'code_ready'] },
  { id: 'review', label: '代码审查', enabled: true, statuses: [] },
  { id: 'build', label: '构建验证', enabled: true, statuses: [] },
  { id: 'device', label: '设备验收', enabled: true, statuses: [] },
  { id: 'integration', label: '提测', enabled: true, statuses: ['delivery_ready', 'device_concluded', 'delivery_queued', 'delivering', 'awaiting_merge'] },
  { id: 'knowledge', label: '知识回流', enabled: true, statuses: ['knowledge_review', 'completed'] },
] as const satisfies readonly { id: string; label: string; enabled: boolean; statuses: readonly CloudStatus[] }[]
export type CloudStageId = typeof CLOUD_STAGES[number]['id']
export function cloudStageForStatus(status: CloudStatus) {
  return CLOUD_STAGES.find(stage => (stage.statuses as readonly CloudStatus[]).includes(status))
}
export interface CloudSummary {
  total: number
  byStatus: Partial<Record<CloudStatus, number>>
  byStage: Partial<Record<CloudStageId, number>>
  issuesByStage?: Partial<Record<CloudStageId, number>>
}
export interface CloudTaskList { items: CloudTask[]; total: number; page: number; summary: CloudSummary }

export const HARNESS_PHASES = [
  ['initialized', '档案初始化'], ['context_ready', '上下文就绪'], ['evidence_ready', '证据就绪'],
  ['scope_approved', '范围审批'], ['ui_prototype_approved', 'UI 原型审批'], ['implemented', '代码实现'],
  ['wired', '调用链接通'], ['build_passed', '构建验证'], ['device_smoke_passed', '设备冒烟'],
  ['visual_parity_passed', '视觉验收'], ['functional_parity_passed', '功能验收'], ['delivery_ready', '交付就绪'],
] as const
export interface CloudHarness {
  lifecycle?: CloudExecutionLifecycle
  continuation?: { status: string; canEndTurn: boolean; reason: string; pending: CloudHarnessAction[]; blocked: CloudHarnessAction[]; readyScenarios: string[]; diagnosisScenarios: string[] }
  acceptance?: { configured: boolean; exhausted: boolean; pendingIssues: string[]; closeoutMissing: string[] }
  preflight?: { configured: boolean; digest: string }
  codeReview?: CloudCodeReview
  phase: string; checkedAt: string; branch: string; worktree: string; runDir: string
  nodes: { id: string; label: string; status: 'passed' | 'blocked' | 'pending' }[]
  blockers: { code: string; message: string }[]; next: string[]; reviewPackage: string
}
export interface CloudHarnessAction { action: string; owner: string; reason: string; condition: string; scenarios: string[] }

export const HARNESS_STAGE: Record<typeof HARNESS_PHASES[number][0], CloudStageId> = {
  initialized: 'preparation', context_ready: 'analysis', evidence_ready: 'analysis',
  scope_approved: 'approval', ui_prototype_approved: 'approval', implemented: 'coding', wired: 'coding',
  build_passed: 'build', device_smoke_passed: 'device', visual_parity_passed: 'device',
  functional_parity_passed: 'device', delivery_ready: 'integration',
}
export function cloudStageForHarness(value: CloudHarness, execution = false): CloudStageId {
  const index = HARNESS_PHASES.findIndex(([id]) => id === value.phase)
  // A failed historical gate during execution is a coding blocker, not a new analysis run.
  if (execution && index < HARNESS_PHASES.findIndex(([id]) => id === 'implemented')) return 'coding'
  if (index < 0) return 'preparation'
  if (value.phase === 'ui_prototype_approved') return 'ready'
  if (index >= HARNESS_PHASES.findIndex(([id]) => id === 'wired') && value.codeReview?.status !== 'passed') return 'review'
  if (value.phase === 'delivery_ready') return 'integration'
  return HARNESS_STAGE[HARNESS_PHASES[index + 1][0]]
}
export interface CloudExecutionLifecycle {
  materialVersion: number
  stage: CloudStageId
  passedNodes: string[]
  reviewPassed: boolean
}
const EXECUTION_STAGES: readonly CloudStageId[] = ['coding', 'review', 'build', 'device']
// Presentation history only. Never use this to authorize execution or pass a gate.
export function executionLifecycle(value: CloudHarness, materialVersion: number, previous?: CloudExecutionLifecycle, checkpoint?: string): CloudExecutionLifecycle {
  const prior = previous?.materialVersion === materialVersion ? previous : undefined
  const current = cloudStageForHarness(value, true)
  const rank = Math.max(EXECUTION_STAGES.indexOf(current), EXECUTION_STAGES.indexOf(prior?.stage as CloudStageId), EXECUTION_STAGES.indexOf(checkpoint as CloudStageId))
  const stage = current === 'integration' ? current : EXECUTION_STAGES[Math.max(0, rank)]
  return { materialVersion, stage, passedNodes: [...new Set([...(prior?.passedNodes || []), ...value.nodes.filter(node => node.status === 'passed').map(node => node.id)])], reviewPassed: prior?.reviewPassed === true || value.codeReview?.status === 'passed' }
}
export interface CloudCodeReview {
  status: 'running' | 'passed' | 'failed' | 'stale' | 'pending'
  summary: string
  checks: { id: string; status: 'passed' | 'failed' | 'blocked'; evidence: string }[]
  findings: { issueId?: string; severity: 'P0' | 'P1' | 'P2' | 'P3'; path: string; line: number; message: string }[]
  round?: number
  elapsedMs?: number
  startedAt?: string
  completedAt?: string
  roundElapsedMs?: number
}
export interface CloudReview {
  kind: 'scope' | 'ui' | 'visual'
  digest: string
  materialVersion: number
  content: string
  decision: 'approved' | 'not_applicable' | 'accepted_with_differences'
  files: { id: string; label: string; mime: string }[]
}
