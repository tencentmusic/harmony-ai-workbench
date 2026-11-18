import type { CloudCodeReview, CloudRun } from '@/contracts/cloud-agent'

export function reviewProgress(report: CloudCodeReview, run: CloudRun | undefined, executing: boolean, now: number) {
  const started = Date.parse(report.startedAt || ''), completed = Date.parse(report.completedAt || '')
  const ownsRound = !!run && started >= Date.parse(run.createdAt)
  const live = executing && run?.status === 'running'
  const reviewing = live && report.status === 'running' && (!Number.isFinite(started) || ownsRound)
  const repairing = live && ownsRound && Number.isFinite(completed) && ['failed', 'stale'].includes(report.status)
  const ticking = ownsRound && (reviewing || repairing)
  const stop = live ? now : Date.parse(run?.finishedAt || '')
  const unfinished = ownsRound && Number.isFinite(started) && !Number.isFinite(completed) && Number.isFinite(stop)
  const roundMs = unfinished ? Math.max(0, stop - started) : report.roundElapsedMs
  const totalMs = (report.elapsedMs || 0) + (unfinished ? roundMs || 0 : 0)
  const label = report.status === 'passed' ? '通过' : reviewing ? (report.round || 1) > 1 ? '复审中' : '审查中'
    : repairing ? '修复中' : !live && (run?.error || report.status === 'running') ? '已暂停'
    : { failed: '待修复', stale: '需重审', pending: '待审查', running: '待复审' }[report.status]
  return { label, ticking, roundMs, totalMs, repairMs: repairing ? Math.max(0, now - completed) : undefined }
}

export function reviewDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
}
