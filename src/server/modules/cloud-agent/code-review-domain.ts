import { CloudError, record } from './domain'
import type { CloudCodeReview } from '@/contracts/cloud-agent'

export const CODE_CHECKS = ['reachability', 'negative conclusions', 'ui interaction boundaries', 'security and regressions'] as const
export class ReadCoverage {
  private offsets = new Map<string, number>()
  private complete = new Set<string>()
  invalidate(key: string) { this.offsets.delete(key); this.complete.delete(key) }
  completed() { return [...this.complete] }
  snapshot() { return { offsets: [...this.offsets], complete: [...this.complete] } }
  restore(value: unknown) {
    const saved = record(value)
    if (!Array.isArray(saved.offsets) || !Array.isArray(saved.complete)) throw new CloudError('审查读取检查点非法', 409)
    const offsets = new Map<string, number>()
    for (const row of saved.offsets) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] < 0 || offsets.has(row[0])) throw new CloudError('审查读取偏移非法', 409)
      offsets.set(row[0], row[1])
    }
    if (saved.complete.some(key => typeof key !== 'string' || !offsets.has(key))) throw new CloudError('审查完整读取检查点缺少偏移', 409)
    this.offsets = offsets
    this.complete = new Set(saved.complete as string[])
  }
  add(key: string, offset: number, chunk: Record<string, unknown>) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== (this.offsets.get(key) ?? 0) || typeof chunk.text !== 'string') return
    if (chunk.nextOffset !== null && (chunk.nextOffset !== offset + chunk.text.length || chunk.text.length === 0)) return
    this.offsets.set(key, offset + chunk.text.length)
    if (chunk.nextOffset === null) this.complete.add(key)
  }
  pending(keys: string[]) {
    return [...new Set(keys)].filter(key => !this.complete.has(key)).map(key => ({ key, offset: this.offsets.get(key) ?? 0 }))
  }
  require(keys: string[]) {
    const missing = this.pending(keys)
    if (missing.length) throw new CloudError(`审查缺少完整读取证据：${missing.map(item => `${item.key}（从 offset=${item.offset} 继续）`).join('、')}`, 409)
  }
}

export class ReviewContinuation {
  private previous = ''
  private unchanged = 0
  private turns = 0
  next(coverage: ReadCoverage, keys: string[], output: string, files: string[], exhausted: boolean) {
    const missing = coverage.pending(keys)
    let reportIssue = ''
    if (!missing.length) {
      try { parseCodeReview(output, files); return null }
      catch (error) {
        if (!(error instanceof CloudError) && !(error instanceof SyntaxError)) throw error
        reportIssue = error instanceof CloudError ? error.message : '报告必须是有效 JSON'
      }
    }
    if (exhausted) throw new CloudError('独立审查工具预算已耗尽，未跳过读取或报告校验', 409)
    const signature = JSON.stringify({ missing, reportIssue })
    this.unchanged = signature === this.previous ? this.unchanged + 1 : 0
    this.previous = signature
    if (this.unchanged >= 3 || this.turns >= 12) throw new CloudError(`独立审查${this.unchanged >= 3 ? '连续三轮无读取或报告修复进展' : '达到十二轮补读上限'}：${missing.map(item => `${item.key} offset=${item.offset}`).join('；') || reportIssue}`, 409)
    this.turns++
    const requests = missing.slice(0, 20).map(({ key, offset }) => {
      if (key === 'diff') return { tool: 'review_diff', arguments: { offset } }
      const colon = key.indexOf(':'), kind = key.slice(0, colon), path = key.slice(colon + 1)
      if (kind === 'archive') {
        const [archive, entry] = JSON.parse(path) as [string, string]
        return { tool: 'source_archive', arguments: { path: archive, entry, offset } }
      }
      if (kind === 'harmony' && /\.(png|jpe?g|webp)$/i.test(path)) return { tool: 'review_image', arguments: { path } }
      return { tool: kind === 'rule' ? 'harness_rule' : kind === 'artifact' ? 'artifact_read' : 'source_read',
        arguments: { path, offset, ...(['android', 'harmony'].includes(kind) ? { platform: kind } : {}) } }
    })
    return `独立审查自动补读 ${this.turns}/12，继续当前审查会话，不重建实例、不要求编码 Agent 代读。保留已发现的代码问题，不因补读清除 findings。\n尚缺 ${missing.length} 项完整读取；按下列工具参数继续，offset 是返回的字符偏移，不是行号；每次使用 nextOffset 直到 null：${JSON.stringify(requests)}。剩余项会在下一回合检查。\n${reportIssue ? `报告问题：${reportIssue}。` : ''}完成阅读后重新核对结论并输出完整 JSON 报告，包含全部 reviewedFiles、四类 checks、已有及新增 findings；不能只返回补读摘要，不能伪造通过。`
  }
}
export function parseCodeReview(raw: string, files: string[]): CloudCodeReview {
  if (raw.length > 60000) throw new CloudError('代码审查报告过大', 413)
  const value = record(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')))
  const text = (v: unknown, max: number) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CloudError('审查报告缺少有效说明', 409); return v }
  if (!Array.isArray(value.checks) || value.checks.length !== CODE_CHECKS.length || !Array.isArray(value.findings) || value.findings.length > 80) throw new CloudError('审查报告检查项不完整', 409)
  const checks = value.checks.map(item => {
    const row = record(item)
    if (!CODE_CHECKS.includes(row.id as typeof CODE_CHECKS[number]) || !['passed', 'failed', 'blocked'].includes(String(row.status))) throw new CloudError('审查检查项非法', 409)
    return { id: String(row.id), status: row.status as 'passed' | 'failed' | 'blocked', evidence: text(row.evidence, 3000) }
  })
  if (new Set(checks.map(c => c.id)).size !== CODE_CHECKS.length) throw new CloudError('审查检查项重复', 409)
  const reviewedFiles = value.reviewedFiles
  if (!Array.isArray(reviewedFiles) || reviewedFiles.some(file => typeof file !== 'string' || !file.trim()) || new Set(reviewedFiles).size !== reviewedFiles.length) throw new CloudError('审查文件清单非法或重复', 409)
  // Reviewers may also list Android callers/ledgers; actual reads are checked separately.
  const missingFiles = files.filter(file => !reviewedFiles.includes(file))
  if (missingFiles.length) throw new CloudError(`审查未覆盖全部变更文件，缺少：${JSON.stringify(missingFiles)}`, 409)
  const findings = value.findings.map(item => {
    const row = record(item)
    if (!['P0', 'P1', 'P2', 'P3'].includes(String(row.severity)) || typeof row.path !== 'string' || !files.includes(row.path) || !Number.isSafeInteger(row.line) || Number(row.line) < 1) throw new CloudError('审查问题位置或等级非法', 409)
    if (row.issueId !== undefined && (typeof row.issueId !== 'string' || !/^R-[a-f0-9]{16}$/.test(row.issueId))) throw new CloudError('审查问题ID非法', 409)
    return { ...(row.issueId ? { issueId: String(row.issueId) } : {}), severity: row.severity as 'P0' | 'P1' | 'P2' | 'P3', path: row.path, line: Number(row.line), message: text(row.message, 3000) }
  })
  return { status: checks.every(c => c.status === 'passed') && findings.every(f => f.severity === 'P3') ? 'passed' : 'failed', summary: text(value.summary, 4000), checks, findings }
}
