import { createHash } from 'node:crypto'
import type { CloudCodeReview } from '@/contracts/cloud-agent'
import { CloudError, record } from './domain'
import { ReadCoverage } from './code-review-domain'

export async function refreshReviewCoverage(coverage: ReadCoverage, hashes: Map<string, string>, fingerprint: (key: string) => Promise<string>, reusable: boolean) {
  if (!reusable) { hashes.clear(); return { coverage: new ReadCoverage(), changed: [] as string[], existing: [] as string[] } }
  const changed: string[] = [], existing: string[] = []
  for (const [key, digest] of hashes) {
    const current = await fingerprint(key).catch(() => '')
    if (current !== digest) { coverage.invalidate(key); hashes.delete(key); changed.push(key); if (current) existing.push(key) }
  }
  coverage.invalidate('diff')
  return { coverage, changed, existing }
}

export class ReviewCycle {
  rounds = 0
  elapsedMs = 0
  reason = ''
  private previous = ''
  private unchanged = 0
  private cachedRequests = 0
  private readonly deadline: number
  constructor(deadline = Date.now() + 180 * 60_000) { this.deadline = deadline }
  begin(digest: string, now = Date.now()) {
    if (!this.reason && this.rounds >= 8) this.reason = '独立审查已达8轮，需核对反复问题和业务依据；已保留问题清单，不是需求重新审批'
    if (!this.reason && this.elapsedMs >= 60 * 60_000) this.reason = '独立审查累计达到60分钟，暂停重复复审并保留进度'
    if (!this.reason && this.deadline - now < 5 * 60_000) this.reason = '本轮剩余时间不足5分钟，不再启动新审查；保留进度等待续行'
    if (this.reason) throw new CloudError(this.reason, 409)
    this.previous = digest
    this.cachedRequests = 0
    this.rounds++
    return Math.min(15 * 60_000, 60 * 60_000 - this.elapsedMs, this.deadline - now - 30_000)
  }
  cached(digest: string) {
    if (this.previous !== digest) this.cachedRequests = 0
    this.previous = digest
    if (++this.cachedRequests >= 3) this.reason = '连续请求相同输入的审查报告，未修复既有问题；停止空转并保留问题清单'
  }
  finish(duration: number, previousOpen: number, remaining: number, passed: boolean) {
    this.elapsedMs += Math.max(0, duration)
    this.unchanged = !passed && previousOpen > 0 && remaining >= previousOpen ? this.unchanged + 1 : 0
    if (this.unchanged >= 3) this.reason = '连续3轮审查未减少阻断问题，需核对业务分支、冲突结论和修复依据；已保留问题，不自动改写范围'
  }
}

export type ReviewIssue = CloudCodeReview['findings'][number] & { issueId: string }
export function reviewIssues(review: CloudCodeReview): ReviewIssue[] {
  return review.findings.map(finding => ({ ...finding, issueId: finding.issueId || `R-${createHash('sha256').update(JSON.stringify([finding.path, finding.message])).digest('hex').slice(0, 16)}` }))
}

// An old approval never survives a source change; the open findings do.
export function reconcileReviewIssues(raw: string, current: CloudCodeReview, previous: ReviewIssue[]) {
  const value = record(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')))
  const resolutions = Array.isArray(value.resolutions) ? value.resolutions.map(record) : []
  const findings = reviewIssues(current)
  const seen = new Set(findings.map(item => item.issueId))
  if (seen.size !== findings.length) throw new CloudError('审查问题ID重复', 409)
  const previousIds = new Set(previous.map(item => item.issueId))
  for (const resolution of resolutions) {
    if (!previousIds.has(String(resolution.issueId)) || seen.has(String(resolution.issueId)) || !['fixed', 'disproved'].includes(String(resolution.status)) || typeof resolution.evidence !== 'string' || !resolution.evidence.trim() || !Number.isSafeInteger(resolution.line) || Number(resolution.line) < 1 || !Array.isArray(value.reviewedFiles) || !value.reviewedFiles.includes(resolution.path)) throw new CloudError('旧问题核销必须引用已审文件、行号及修复或反证依据，不能静默删除', 409)
  }
  if (new Set(resolutions.map(item => item.issueId)).size !== resolutions.length) throw new CloudError('旧问题核销重复', 409)
  const missing = previous.filter(item => !seen.has(item.issueId) && !resolutions.some(row => row.issueId === item.issueId))
  if (missing.length) throw new CloudError(`旧问题必须保留ID或逐项给出核销证据：${missing.map(item => item.issueId).join('、')}`, 409)
  return { ...current, findings }
}

export function stoppedReview(review: CloudCodeReview | undefined, active: boolean, reason?: string): CloudCodeReview | undefined {
  return review?.status === 'running' && !active ? { ...review, status: 'failed', summary: reason || '独立审查已中断，保留既有问题和证据；不代表仍在执行' } : review
}
