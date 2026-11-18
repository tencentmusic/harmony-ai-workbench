import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReviewCycle, reviewIssues, reconcileReviewIssues, stoppedReview, refreshReviewCoverage } from './review-cycle'
import { ReadCoverage } from './code-review-domain'
import type { CloudCodeReview } from '@/contracts/cloud-agent'

const failed: CloudCodeReview = { status: 'failed', summary: 'fixture', checks: [], findings: [{ path: 'page.ets', line: 1, severity: 'P1', message: 'known defect' }] }
test('changed code cannot silently erase old findings or carry forward approval', () => {
  const issues = reviewIssues(failed)
  const clean = { ...failed, status: 'passed' as const, findings: [] }
  assert.throws(() => reconcileReviewIssues('{}', clean, issues), /旧问题/)
  const raw = { reviewedFiles: ['page.ets'], resolutions: [{ issueId: issues[0].issueId, status: 'fixed', path: 'page.ets', line: 3, evidence: 'fixed guard at line 3' }] }
  assert.equal(reconcileReviewIssues(JSON.stringify(raw), clean, issues).status, 'passed')
  assert.throws(() => reconcileReviewIssues(JSON.stringify({ ...raw, reviewedFiles: [] }), clean, issues), /核销/)
  assert.equal(reconcileReviewIssues('{}', { ...failed, findings: issues }, issues).findings[0].issueId, issues[0].issueId)
})
test('incremental coverage invalidates changed dependencies but retains unchanged reads', () => {
  const coverage = new ReadCoverage()
  for (const key of ['diff', 'harmony:a', 'android:caller']) coverage.add(key, 0, { text: 'content', nextOffset: null })
  coverage.invalidate('diff'); coverage.invalidate('android:caller')
  assert.deepEqual(coverage.pending(['diff', 'harmony:a', 'android:caller']).map(v => v.key), ['diff', 'android:caller'])
})
test('review budget counts tool invocations, no-convergence and remaining time', () => {
  const budget = new ReviewCycle(20 * 60_000)
  assert.equal(budget.begin('a', 0), 15 * 60_000)
  budget.cached('a'); budget.cached('a'); assert.equal(budget.reason, '')
  budget.cached('a'); assert.match(budget.reason, /相同输入/)
  const rounds = new ReviewCycle(200 * 60_000)
  for (let i = 0; i < 8; i++) rounds.begin(String(i), 0)
  assert.throws(() => rounds.begin('last', 0), /8轮/)
  const unchanged = new ReviewCycle()
  for (let i = 0; i < 3; i++) unchanged.finish(100, 2, 2, false)
  assert.match(unchanged.reason, /未减少/)
  assert.throws(() => new ReviewCycle(1000).begin('a', 0), /不足/)
})
test('hash-verified context survives only in the same available conversation', async () => {
  const coverage = new ReadCoverage(), hashes = new Map([['harmony:a', '1'], ['android:caller', '2'], ['harmony:removed', '3']])
  for (const key of ['diff', ...hashes.keys()]) coverage.add(key, 0, { text: 'content', nextOffset: null })
  const result = await refreshReviewCoverage(coverage, hashes, async key => key === 'harmony:a' ? '1' : key === 'android:caller' ? '4' : '', true)
  assert.deepEqual(result.changed, ['android:caller', 'harmony:removed'])
  assert.deepEqual(result.existing, ['android:caller'])
  assert.deepEqual(result.coverage.completed(), ['harmony:a'])
  const cold = await refreshReviewCoverage(coverage, hashes, async () => '1', false)
  assert.deepEqual(cold.coverage.completed(), []); assert.equal(hashes.size, 0)
})
test('stopped task cannot display a running review while preserving findings', () => {
  const running = { ...failed, status: 'running' as const }
  assert.equal(stoppedReview(running, true), running)
  const stopped = stoppedReview(running, false, 'timeout')!
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.summary, 'timeout')
  assert.deepEqual(stopped.findings, failed.findings)
})
