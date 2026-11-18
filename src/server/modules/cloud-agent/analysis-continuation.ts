import { record } from './domain'
import { sha256 } from './scoped-files'

export function analysisCheckpoint(phase: string, evidence: unknown, parity: unknown, candidate?: { signature: string; issues: string[] }) {
  const ledger = record(evidence), matrix = record(parity)
  const coverage = Array.isArray(ledger.coverage) ? ledger.coverage.map(record) : []
  const items = Array.isArray(ledger.items) ? ledger.items.map(record) : []
  const questions = record(ledger.review_package || {}).open_questions
  const open = (Array.isArray(questions) ? questions.map(record) : []).filter(question => question.status === 'open' && question.blocks_scope === true && typeof question.question === 'string' && question.question.trim() && typeof record(question.investigation || {}).remaining_gap === 'string')
  const pending = coverage.filter(item => !['complete', 'not_applicable'].includes(String(item.status)))
  return {
    signature: sha256(JSON.stringify({ phase, coverage: coverage.map(({ area, status, evidence_ids }) => ({ area, status, evidence_ids })), sources: items.map(({ id, sources }) => ({ id, sources })), items: matrix.items, ui: matrix.ui_scope, scenarios: matrix.scenarios, candidate })),
    pending: [...pending.map(item => ({ area: item.area, note: item.note })), ...(candidate?.issues || []).map(note => ({ area: 'ui_candidate', note }))],
    questions: open.map(question => String(question.question)),
    humanOnly: !candidate?.issues.length && coverage.length >= 8 && !pending.length && open.length > 0,
  }
}

export class AnalysisContinuation {
  private previous = ''
  private unchanged = 0
  private continuations = 0
  decide(checkpoint: ReturnType<typeof analysisCheckpoint>) {
    if (checkpoint.humanOnly) return { kind: 'input' as const, reason: `需要补充外部事实：${checkpoint.questions.join('；')}` }
    this.unchanged = checkpoint.signature === this.previous ? this.unchanged + 1 : 0
    this.previous = checkpoint.signature
    if (this.unchanged >= 2) return { kind: 'blocked' as const, reason: '连续两次续跑未产生新的结构化证据，已停止自动重复分析；需检查未完成查证项或工具问题' }
    if (this.continuations >= 4) return { kind: 'blocked' as const, reason: '已达本轮4次自动续跑上限，证据仍未就绪；已保留档案，需检查剩余工程问题' }
    this.continuations++
    return { kind: 'continue' as const, reason: `自动续跑 ${this.continuations}/4：审核包未就绪，继续工程查证，不以阶段总结结束任务` }
  }
}
