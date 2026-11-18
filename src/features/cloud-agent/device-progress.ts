import type { CloudEvent, CloudTask } from '@/contracts/cloud-agent'

export interface DeviceReviewProgress {
  phase: 'preflight' | 'reviewing' | 'complete'
  totalCases: number; reviewCases: number; reusedCases: number
  totalRequired: number; readRequired: number
  startedAt: string; elapsedMs: number
}

const REVIEW_PREFIX = '设备复核进度：'
export function parseDeviceReviewProgress(message: string): DeviceReviewProgress | null {
  if (!message.startsWith(REVIEW_PREFIX)) return null
  try {
    const value: unknown = JSON.parse(message.slice(REVIEW_PREFIX.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (!['preflight', 'reviewing', 'complete'].includes(String(row.phase)) || typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt))) return null
    for (const key of ['totalCases', 'reviewCases', 'reusedCases', 'totalRequired', 'readRequired', 'elapsedMs']) {
      if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) return null
    }
    const result = row as unknown as DeviceReviewProgress
    if (result.readRequired > result.totalRequired || result.reviewCases + result.reusedCases > result.totalCases) return null
    return result
  } catch { return null }
}

export type AcceptanceStepId = 'device' | 'review' | 'visual' | 'delivery'
export type AcceptanceStepStatus = 'pending' | 'active' | 'paused' | 'recorded' | 'attention' | 'waiting' | 'passed' | 'stale'
export interface AcceptanceStep {
  id: AcceptanceStepId; title: string; status: AcceptanceStepStatus; label: string
  metrics: string[]; elapsedMs?: number; timeLabel: string
}
const STEPS: { id: AcceptanceStepId; title: string; gate?: string }[] = [
  { id: 'device', title: '设备执行' },
  { id: 'review', title: '独立复核', gate: 'functional_parity_passed' },
  { id: 'visual', title: '视觉收尾', gate: 'visual_parity_passed' },
  { id: 'delivery', title: '交付准备', gate: 'delivery_ready' },
]
const TOOL_STEP: Record<string, AcceptanceStepId> = {
  harness_test: 'device', harness_device_smoke: 'device', harness_device_step: 'device', harness_device_prepare: 'device',
  harness_device_review: 'review', harness_capture: 'visual', harness_finalize: 'delivery',
}

export function deviceAcceptanceProgress(task: CloudTask, events: CloudEvent[]): AcceptanceStep[] {
  const run = task.runs[0]
  const stale = !!run && run.materialVersion !== task.materialVersion
  const running = run?.status === 'running' && ['translating', 'delivering'].includes(task.status)
  const rows: AcceptanceStep[] = STEPS.map(step => ({ ...step, status: stale ? 'stale' : 'pending', label: stale ? '待更新' : '待执行', metrics: [], timeLabel: '已记录工具耗时' }))
  if (stale) return rows
  const current = [...new Map(events.filter(event => run && event.taskId === task.id && event.runId === run.id && ['tool', 'warning'].includes(event.kind)).map(event => [event.id, event])).values()].sort((a, b) => a.id - b.id)
  const stats = new Map(STEPS.map(step => [step.id, { returned: 0, errors: 0 }]))
  const starts = new Map<string, number>()
  const latestActivity = new Map<AcceptanceStepId, number>()
  let review: DeviceReviewProgress | null = null
  for (const event of current) {
    const snapshot = parseDeviceReviewProgress(event.message)
    if (snapshot) {
      review = snapshot
      latestActivity.set('review', Date.parse(event.createdAt))
      const row = rows[1]
      row.status = snapshot.phase === 'complete' ? 'recorded' : running ? 'active' : 'paused'
      row.label = snapshot.phase === 'complete' ? '复核已结束' : !running ? '已暂停' : snapshot.phase === 'preflight' ? '证据预检' : '复核中'
      continue
    }
    const call = /^(调用|完成) (\w+)(.*)$/.exec(event.message)
    const failure = /^(\w+)：/.exec(event.message)
    const tool = call?.[2] || failure?.[1]
    const id = tool ? TOOL_STEP[tool] : undefined
    if (!id || !tool) continue
    latestActivity.set(id, Date.parse(event.createdAt))
    const row = rows.find(item => item.id === id)!
    const stat = stats.get(id)!
    if (call?.[1] === '调用') {
      if (id === 'review') review = null
      const started = Date.parse(event.createdAt)
      if (Number.isFinite(started)) starts.set(tool, started)
      row.status = running ? 'active' : 'paused'
      row.label = running ? '执行中' : '已暂停'
    } else {
      const start = starts.get(tool), end = Date.parse(event.createdAt)
      if (start !== undefined && Number.isFinite(end) && end >= start) row.elapsedMs = (row.elapsedMs || 0) + end - start
      starts.delete(tool)
      const failed = !!failure || !!call?.[3].trim()
      if (failed) stat.errors++; else stat.returned++
      row.status = failed ? 'attention' : 'recorded'
      row.label = failed ? '执行待处理' : id === 'review' && review?.phase === 'complete' ? '复核已结束' : '已有工具结果'
    }
  }
  for (const row of rows) {
    const stat = stats.get(row.id)!
    if (stat.returned || stat.errors) row.metrics.push(`工具返回 ${stat.returned} 次${stat.errors ? ` · 异常 ${stat.errors} 次` : ''}`)
  }
  if (review) {
    rows[1].metrics = [`用例 ${review.totalCases} 项 · 本次复核 ${review.reviewCases} 项 · 复用 ${review.reusedCases} 项`, `必读证据 ${review.readRequired} / ${review.totalRequired} 份`]
    rows[1].elapsedMs = review.elapsedMs
    rows[1].timeLabel = '累计复核'
  }
  // A tool returning (including a review report) is not a native acceptance pass.
  for (const [index, step] of STEPS.entries()) {
    const activity = latestActivity.get(step.id)
    const checkedAfterActivity = activity === undefined || Date.parse(task.harness?.checkedAt || '') >= activity
    if (step.gate && checkedAfterActivity && task.harness?.nodes.some(node => node.id === step.gate && node.status === 'passed')) {
      rows[index].status = 'passed'
      rows[index].label = step.id === 'review' ? '功能门禁通过' : step.id === 'visual' ? '视觉门禁通过' : '交付就绪'
    }
  }
  if (task.status === 'awaiting_approval' && task.review?.kind === 'visual') {
    rows[2].status = 'waiting'
    rows[2].label = '待确认效果'
  }
  return rows
}
