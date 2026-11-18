import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CODE_CHECKS, parseCodeReview, ReadCoverage, ReviewContinuation } from './code-review-domain'
import { cloudStageForHarness, type CloudHarness } from '@/contracts/cloud-agent'

const report = { summary: 'Fixture review', reviewedFiles: ['app/page.ets'], checks: CODE_CHECKS.map(id => ({ id, status: 'passed', evidence: 'app/page.ets:1 fixture evidence' })), findings: [] }
test('additional reviewed context does not invalidate full change coverage or discard findings', () => {
  const raw = JSON.stringify({ ...report, reviewedFiles: [...report.reviewedFiles, 'android/Entry.java', 'harness/manifest.json'],
    findings: [{ severity: 'P1', path: 'app/page.ets', line: 1, message: 'Preserve actual defect' }] })
  const parsed = parseCodeReview(raw, report.reviewedFiles)
  assert.equal(parsed.status, 'failed')
  assert.equal(parsed.findings[0].message, 'Preserve actual defect')
  const coverage = new ReadCoverage()
  coverage.add('diff', 0, { text: '', nextOffset: null })
  assert.equal(new ReviewContinuation().next(coverage, ['diff'], raw, report.reviewedFiles, false), null)
  for (const reviewedFiles of [['android/Entry.java'], ['app/page.ets', 'app/page.ets'], ['app/page.ets', null]]) {
    assert.throws(() => parseCodeReview(JSON.stringify({ ...report, reviewedFiles }), report.reviewedFiles))
  }
  assert.throws(() => coverage.require(['harmony:app/page.ets']), /完整读取/)
})
test('review continues in the same session at exact missing offsets, retaining findings', () => {
  const coverage = new ReadCoverage(), continuation = new ReviewContinuation()
  const key = 'android:app/MainHomeFragment.java', keys = [key]
  coverage.add(key, 0, { text: 'x'.repeat(24000), nextOffset: 24000 })
  assert.deepEqual(coverage.pending(keys), [{ key, offset: 24000 }])
  const failed = JSON.stringify({ ...report, findings: [{ severity: 'P1', path: 'app/page.ets', line: 1, message: 'Keep this defect' }] })
  const next = () => continuation.next(coverage, keys, failed, ['app/page.ets'], false)
  assert.match(next()!, /source_read.*24000/)
  coverage.add(key, 24000, { text: 'x'.repeat(24000), nextOffset: 48000 })
  assert.match(next()!, /48000/)
  coverage.add(key, 48000, { text: 'x'.repeat(24000), nextOffset: 72000 })
  assert.match(next()!, /72000/)
  coverage.add(key, 72000, { text: 'x'.repeat(21180), nextOffset: null })
  assert.equal(next(), null, 'a valid failed report must reach the implementation agent')
  assert.equal(parseCodeReview(failed, ['app/page.ets']).status, 'failed')
})

test('review coverage diagnostics retain strict gap checking and bounded continuation', () => {
  const coverage = new ReadCoverage(), continuation = new ReviewContinuation(), keys = ['diff', 'rule:START_HERE.md', 'artifact:harness/manifest.json', 'harmony:app/page.ets']
  const next = () => continuation.next(coverage, keys, JSON.stringify(report), ['app/page.ets'], false)
  const prompt = next()!
  for (const tool of ['review_diff', 'harness_rule', 'artifact_read', 'source_read']) assert.ok(prompt.includes(tool))
  next(); next()
  assert.throws(next, /无.*进展/)
  assert.throws(() => new ReviewContinuation().next(coverage, keys, '', ['app/page.ets'], true), /预算/)
})

test('review corrects malformed reports without rerunning successful reads', () => {
  const continuation = new ReviewContinuation(), coverage = new ReadCoverage()
  coverage.add('diff', 0, { text: '', nextOffset: null })
  assert.match(continuation.next(coverage, ['diff'], 'not json', ['app/page.ets'], false)!, /JSON/)
  assert.equal(continuation.next(coverage, ['diff'], JSON.stringify(report), ['app/page.ets'], false), null)
})

test('review ignores invalid page offsets and stops total continuation even when reads advance', () => {
  const coverage = new ReadCoverage(), continuation = new ReviewContinuation()
  for (const offset of [-1, NaN, 0.5]) coverage.add('diff', offset, { text: 'x', nextOffset: null })
  coverage.add('diff', 0, { text: 'x', nextOffset: 99 })
  assert.deepEqual(coverage.pending(['diff']), [{ key: 'diff', offset: 0 }])
  for (let offset = 0; offset < 12; offset++) {
    coverage.add('diff', offset, { text: 'x', nextOffset: offset + 1 })
    assert.ok(continuation.next(coverage, ['diff'], '', ['app/page.ets'], false))
  }
  coverage.add('diff', 12, { text: 'x', nextOffset: 13 })
  assert.throws(() => continuation.next(coverage, ['diff'], '', ['app/page.ets'], false), /十二轮/)
})
test('review coverage rejects skipped chunks and missing Android/ledger reads', () => {
  const coverage = new ReadCoverage()
  coverage.add('harmony:a', 24000, { text: 'tail', nextOffset: null })
  assert.throws(() => coverage.require(['harmony:a', 'android:b']))
  coverage.add('harmony:a', 0, { text: 'first', nextOffset: 5 })
  coverage.add('harmony:a', 5, { text: 'tail', nextOffset: null })
  assert.throws(() => coverage.require(['harmony:a', 'android:b']))
  coverage.add('android:b', 0, { text: 'source', nextOffset: null })
  coverage.require(['harmony:a', 'android:b'])
})
test('code review fails closed for incomplete coverage, checks and blocking findings', () => {
  const parse = (value: unknown) => parseCodeReview(JSON.stringify(value), ['app/page.ets'])
  assert.equal(parse(report).status, 'passed')
  assert.throws(() => parse({ ...report, reviewedFiles: [] }))
  assert.throws(() => parse({ ...report, checks: report.checks.slice(1) }))
  assert.equal(parse({ ...report, findings: [{ severity: 'P1', path: 'app/page.ets', line: 1, message: 'fixture defect' }] }).status, 'failed')
  assert.equal(parse({ ...report, checks: report.checks.map(c => ({ ...c, status: 'blocked' })) }).status, 'failed')
})
test('wired routes to code review until a current review passes', () => {
  const value = { phase: 'wired' } as CloudHarness
  assert.equal(cloudStageForHarness(value), 'review')
  assert.equal(cloudStageForHarness({ ...value, codeReview: { status: 'passed', summary: '', checks: [], findings: [] } }), 'build')
  assert.equal(cloudStageForHarness({ ...value, codeReview: { status: 'stale', summary: '', checks: [], findings: [] } }), 'review')
  for (const phase of ['build_passed', 'device_smoke_passed', 'delivery_ready']) {
    assert.equal(cloudStageForHarness({ ...value, phase, codeReview: { status: 'stale', summary: '', checks: [], findings: [] } }), 'review')
  }
})
