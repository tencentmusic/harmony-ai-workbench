import { cloudStageForStatus, cloudStageForHarness, type CloudTask } from '@/contracts/cloud-agent'

export const TASK_NODES = [
  { id: 'material', label: '需求材料', phases: ['initialized'] },
  { id: 'analysis', label: '需求分析', phases: ['context_ready', 'evidence_ready'] },
  { id: 'approval', label: '人工审核', phases: ['scope_approved', 'ui_prototype_approved'] },
  { id: 'coding', label: '代码转译', phases: ['implemented', 'wired'] },
  { id: 'review', label: '代码审查', phases: [] },
  { id: 'build', label: '构建验证', phases: ['build_passed'] },
  { id: 'device', label: '设备验收', phases: ['device_smoke_passed', 'visual_parity_passed', 'functional_parity_passed'] },
  { id: 'integration', label: '提测', phases: ['delivery_ready'] },
  { id: 'knowledge', label: '知识回流', phases: [] },
] as const
export type TaskNodeId = typeof TASK_NODES[number]['id']
export type TaskNodeStatus = 'passed' | 'current' | 'waiting' | 'blocked' | 'pending' | 'stale' | 'recheck'
export const NODE_STATUS: Record<TaskNodeStatus, string> = { passed: '已完成', current: '进行中', waiting: '待确认', blocked: '待处理', pending: '未完成', stale: '待更新', recheck: '待复核' }
export function currentTaskNode(task: CloudTask): TaskNodeId {
  if (task.status === 'awaiting_approval') return task.review?.kind === 'visual' ? 'device' : 'approval'
  const stage = task.stage || cloudStageForStatus(task.status)?.id
  return stage === 'preparation' ? 'material' : stage === 'ready' ? 'coding' : stage || 'material'
}
export function taskWorkflow(task: CloudTask) {
  const current = currentTaskNode(task)
  const stale = (task.runs[0] && task.runs[0].materialVersion !== task.materialVersion) || (task.review && task.review.materialVersion !== task.materialVersion)
  return TASK_NODES.map(node => {
    const evidence = node.phases.map(id => task.harness?.nodes.find(item => item.id === id))
    const passed = node.id === 'material' ? !!task.material || !!task.attachments.length
      : node.id === 'review' ? task.harness?.codeReview?.status === 'passed'
      : node.id === 'integration' ? task.delivery?.handoff?.status === 'submitted' || task.delivery?.codeMerged === true
      : node.id === 'knowledge' ? task.status === 'completed' && task.deviceConclusion?.result !== 'incomplete'
      : evidence.length > 0 && evidence.every(item => item?.status === 'passed')
    let status: TaskNodeStatus = passed ? 'passed' : 'pending'
    const history = task.harness?.lifecycle?.materialVersion === task.materialVersion ? task.harness.lifecycle : undefined
    if (!passed && (node.id === 'review' ? history?.reviewPassed : evidence.length > 0 && node.phases.every(id => history?.passedNodes.includes(id)))) status = 'recheck'
    if (node.id === 'device' && task.deviceConclusion?.result === 'incomplete') status = 'blocked'
    if (stale && node.id !== 'material') status = 'stale'
    else if (node.id === current && !(node.id === 'integration' && passed && task.status === 'awaiting_merge') && !['cancelled', 'completed'].includes(task.status)) {
      status = task.status === 'awaiting_approval' || ['awaiting_merge', 'knowledge_review', 'delivery_ready', 'device_concluded', 'approved'].includes(task.status) ? 'waiting'
        : ['failed', 'blocked', 'harness_waiting', 'awaiting_input'].includes(task.status) ? 'blocked' : 'current'
    }
    return { ...node, status }
  })
}

export function taskRepair(task: CloudTask) {
  const harness = task.harness, stage = currentTaskNode(task)
  if (!harness || !['review', 'build', 'device'].includes(stage)) return null
  if (['awaiting_approval', 'review_queued', 'reviewing'].includes(task.status)) return null
  const raw = cloudStageForHarness(harness, true)
  if (!['coding', 'review', 'build'].includes(raw) || (stage === 'review' && raw !== 'coding')) return null
  const passed = (id: string) => harness.nodes.some(node => node.id === id && node.status === 'passed')
  const index = raw === 'coding' ? passed('implemented') ? 1 : 0 : raw === 'review' ? 2 : 3
  const labels = ['局部修复', '更新接线证据', '代码复审', '重新构建']
  if (stage === 'device') labels.push('重新验收')
  const historicalBuild = harness.lifecycle?.passedNodes.includes('build_passed') || harness.blockers.some(item => /build/i.test(item.code))
  if (raw === stage && raw === 'build' && !historicalBuild) return null
  return { title: `${stage === 'device' ? '设备验收' : stage === 'build' ? '构建验证' : '代码审查'} · ${labels[index]}`, index,
    paused: !['translating', 'translation_queued'].includes(task.status),
    steps: labels.map((label, i) => ({ label, status: i === index ? 'current' : i < index ? 'passed' : 'pending' })) }
}
