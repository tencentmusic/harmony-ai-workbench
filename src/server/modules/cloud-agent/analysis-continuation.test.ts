import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analysisCheckpoint, AnalysisContinuation } from './analysis-continuation'

const evidence = (status = 'pending') => ({ coverage: Array.from({ length: 8 }, (_, i) => ({ area: String(i), status })), review_package: { open_questions: [{ status: 'open', blocks_scope: true, question: '录屏版本？', investigation: { remaining_gap: '版本未知' } }] } })

test('UI draft defects continue as engineering work and changed candidates count as progress', () => {
  const policy = new AnalysisContinuation()
  const a = analysisCheckpoint('scope_approved', evidence('complete'), {}, { signature: 'a', issues: ['缺少原型'] })
  assert.equal(a.humanOnly, false)
  assert.equal(a.pending[0].area, 'ui_candidate')
  assert.equal(policy.decide(a).kind, 'continue')
  assert.equal(policy.decide(a).kind, 'continue')
  const b = analysisCheckpoint('scope_approved', evidence('complete'), {}, { signature: 'b', issues: ['缺少渲染图'] })
  assert.notEqual(a.signature, b.signature)
  assert.equal(policy.decide(b).kind, 'continue')
})
test('unresolved engineering continues despite a human question; repetition is bounded', () => {
  const policy = new AnalysisContinuation(), snapshot = analysisCheckpoint('context_ready', evidence(), {})
  assert.equal(snapshot.humanOnly, false)
  assert.equal(policy.decide(snapshot).kind, 'continue')
  assert.equal(policy.decide(snapshot).kind, 'continue')
  assert.equal(policy.decide(snapshot).kind, 'blocked')
})
test('only complete coverage with explicit external questions can await input', () => {
  const snapshot = analysisCheckpoint('context_ready', evidence('complete'), {})
  assert.equal(new AnalysisContinuation().decide(snapshot).kind, 'input')
  assert.equal(analysisCheckpoint('context_ready', { coverage: [] }, {}).humanOnly, false)
})
test('changing evidence cannot evade continuation budget; prose changes are not progress', () => {
  const policy = new AnalysisContinuation()
  for (let i = 0; i < 4; i++) assert.equal(policy.decide(analysisCheckpoint('context_ready', evidence(), { items: [{ id: i }] })).kind, 'continue')
  assert.equal(policy.decide(analysisCheckpoint('context_ready', evidence(), { items: [{ id: 5 }] })).kind, 'blocked')
  assert.equal(analysisCheckpoint('context_ready', { ...evidence(), note: 'a' }, {}).signature, analysisCheckpoint('context_ready', { ...evidence(), note: 'b' }, {}).signature)
})
