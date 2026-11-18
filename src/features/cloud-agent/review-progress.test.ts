import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CloudCodeReview, CloudRun } from '@/contracts/cloud-agent'
import { reviewProgress } from './review-progress'

const epoch = Date.parse('2026-10-12T00:00:00Z')
const report: CloudCodeReview = { status: 'running', round: 2, elapsedMs: 387000, startedAt: new Date(epoch).toISOString(), summary: '', checks: [], findings: [] }
const run: CloudRun = { id: 'run', status: 'running', createdAt: new Date(epoch - 1000).toISOString(), finishedAt: null, error: null, baseSha: null, output: '', digest: null, materialVersion: 1, materialSnapshot: '', attachments: [] }
test('review clock adds current round without double counting completed rounds or repair time', () => {
  assert.equal(reviewProgress(report, run, true, epoch + 20000).totalMs, 407000)
  assert.equal(reviewProgress(report, run, true, epoch + 20000).label, '复审中')
  const ended = { ...report, status: 'failed' as const, completedAt: new Date(epoch + 80000).toISOString(), roundElapsedMs: 80000, elapsedMs: 467000 }
  const fixing = reviewProgress(ended, run, true, epoch + 90000)
  assert.equal(fixing.label, '修复中'); assert.equal(fixing.repairMs, 10000); assert.equal(fixing.totalMs, 467000)
  assert.equal(reviewProgress({ ...ended, status: 'passed' }, run, true, epoch + 100000).ticking, false)
})
test('paused, old-run and legacy records do not keep a live timer', () => {
  const stopped = { ...run, status: 'failed', error: 'timeout', finishedAt: new Date(epoch + 20000).toISOString() }
  assert.equal(reviewProgress(report, stopped, false, epoch + 50000).totalMs, 407000)
  assert.equal(reviewProgress(report, stopped, false, epoch + 90000).label, '已暂停')
  assert.equal(reviewProgress(report, { ...run, createdAt: new Date(epoch + 1000).toISOString() }, true, epoch + 90000).ticking, false)
  assert.equal(reviewProgress({ ...report, startedAt: undefined }, run, true, epoch + 90000).totalMs, 387000)
})
