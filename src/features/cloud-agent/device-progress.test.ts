import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CloudEvent, CloudTask } from '@/contracts/cloud-agent'
import { deviceAcceptanceProgress, parseDeviceReviewProgress } from './device-progress'

const epoch = '2026-10-14T08:00:00Z'
const task: CloudTask = {
  id: 'task', appId: 'app', title: 'cover video', material: '', targetBranch: 'release', model: 'model',
  source: 'manual', sourceUrl: null, status: 'translating', stage: 'device', revision: 1, materialVersion: 1,
  createdAt: epoch, updatedAt: epoch, attachments: [], actions: [],
  runs: [{ id: 'run', status: 'running', createdAt: epoch, finishedAt: null, materialVersion: 1,
    kind: 'translation', baseSha: null, output: '', digest: null, error: null, materialSnapshot: '', attachments: [] }],
  harness: { phase: 'device_smoke_passed', checkedAt: epoch, branch: 'feature/test', worktree: '', runDir: '', nodes: [], blockers: [], next: [], reviewPackage: '' },
}
const progress = { phase: 'reviewing', totalCases: 3, reviewCases: 2, reusedCases: 1, totalRequired: 10, readRequired: 4, startedAt: epoch, elapsedMs: 61000 }
const event = (id: number, message: string, kind = 'tool', runId = 'run'): CloudEvent => ({ id, taskId: 'task', runId, kind, message, createdAt: new Date(Date.parse(epoch) + id * 1000).toISOString() })
const notice = (id: number, overrides = {}) => event(id, `设备复核进度：${JSON.stringify({ ...progress, ...overrides })}`)

test('device review notices validate structured counts and never accept model prose', () => {
  assert.deepEqual(parseDeviceReviewProgress(notice(1).message), progress)
  for (const change of [{ totalCases: -1 }, { readRequired: 11 }, { elapsedMs: '12' }, { reusedCases: 4 }, { reviewCases: 4 }, { startedAt: 'invalid' }, { phase: 'passed' }, { totalRequired: 2.5 }]) {
    assert.equal(parseDeviceReviewProgress(notice(1, change).message), null)
  }
  assert.equal(parseDeviceReviewProgress('设备复核进度：not-json'), null)
  assert.equal(parseDeviceReviewProgress('模型表示设备复核进度：{}'), null)
  const rows = deviceAcceptanceProgress(task, [event(1, notice(1).message, 'output')])
  assert.equal(rows[1].status, 'pending')
})

test('review displays real evidence coverage, reused cases and reported duration without percentages', () => {
  const row = deviceAcceptanceProgress(task, [notice(1)])[1]
  assert.equal(row.status, 'active')
  assert.equal(row.label, '复核中')
  assert.deepEqual(row.metrics, ['用例 3 项 · 本次复核 2 项 · 复用 1 项', '必读证据 4 / 10 份'])
  assert.equal(row.elapsedMs, 61000)
  assert.equal(row.timeLabel, '累计复核')
})

test('preflight and completed review are distinct from an acceptance pass', () => {
  assert.equal(deviceAcceptanceProgress(task, [notice(1, { phase: 'preflight' })])[1].label, '证据预检')
  const rows = deviceAcceptanceProgress(task, [notice(1, { phase: 'complete', readRequired: 10 })])
  assert.equal(rows[1].status, 'recorded')
  assert.equal(rows[1].label, '复核已结束')
  assert.equal(rows[2].status, 'pending')
  assert.equal(rows[3].status, 'pending')
})

test('only current task and run events count; deduplication and ordering do not mutate input', () => {
  const events = [notice(3, { readRequired: 6 }), notice(1), notice(3, { readRequired: 6 }), event(4, notice(4).message, 'tool', 'old'), { ...notice(5), taskId: 'other' }]
  const original = JSON.stringify(events)
  assert.equal(deviceAcceptanceProgress(task, events)[1].metrics[1], '必读证据 6 / 10 份')
  assert.equal(JSON.stringify(events), original)
  assert.equal(deviceAcceptanceProgress({ ...task, runs: [] }, events)[1].status, 'pending')
})

test('recorded tool time excludes model idle gaps and failed returns never count as completion', () => {
  const rows = deviceAcceptanceProgress(task, [
    event(1, '调用 harness_test'), event(3, '完成 harness_test'),
    event(8, '调用 harness_test'), event(10, '完成 harness_test（需处理返回问题）'),
    event(20, '调用 harness_test'), event(22, 'harness_test：设备未连接'),
  ])
  assert.equal(rows[0].elapsedMs, 6000)
  assert.deepEqual(rows[0].metrics, ['工具返回 1 次 · 异常 2 次'])
  assert.equal(rows[0].status, 'attention')
  assert.equal(rows[0].label, '执行待处理')
})

test('stopped runs keep reported duration frozen and never show a running review', () => {
  const stopped = { ...task, status: 'harness_waiting' as const, runs: [{ ...task.runs[0], status: 'failed', finishedAt: '2026-10-14T08:02:00Z' }] }
  const row = deviceAcceptanceProgress(stopped, [notice(1)])[1]
  assert.equal(row.status, 'paused')
  assert.equal(row.elapsedMs, 61000)
})

test('visual approval and delivery completion come from current native gates, not inference', () => {
  const waiting = { ...task, status: 'awaiting_approval' as const, review: { kind: 'visual' as const, digest: 'digest', materialVersion: 1, content: '', decision: 'approved' as const, files: [] } }
  assert.equal(deviceAcceptanceProgress(waiting, [notice(1, { phase: 'complete' })])[2].label, '待确认效果')
  const complete = { ...task, harness: { ...task.harness!, nodes: ['functional_parity_passed', 'visual_parity_passed', 'delivery_ready'].map(id => ({ id, label: id, status: 'passed' as const })) } }
  const rows = deviceAcceptanceProgress(complete, [])
  assert.equal(rows[1].status, 'passed')
  assert.equal(rows[2].status, 'passed')
  assert.equal(rows[3].status, 'passed')
})

test('changed material does not display stale counts or stale passed gates', () => {
  const rows = deviceAcceptanceProgress({ ...task, materialVersion: 2 }, [notice(1, { phase: 'complete' })])
  assert.ok(rows.every(row => row.status === 'stale' && row.metrics.length === 0 && row.elapsedMs === undefined))
})

test('missing or truncated history shows unknown timing instead of reconstructing whole-run duration', () => {
  const rows = deviceAcceptanceProgress(task, [event(40, '完成 harness_capture')])
  assert.equal(rows[2].elapsedMs, undefined)
  assert.equal(rows[2].label, '已有工具结果')
  assert.equal(rows[0].elapsedMs, undefined)
  assert.equal(rows[0].status, 'pending')
})

test('a new review supersedes an older passed gate until native verification catches up', () => {
  const previousPass = { ...task, harness: { ...task.harness!, nodes: [{ id: 'functional_parity_passed', label: 'functional', status: 'passed' as const }] } }
  assert.equal(deviceAcceptanceProgress(previousPass, [notice(1)])[1].status, 'active')
  assert.equal(deviceAcceptanceProgress(previousPass, [notice(1, { phase: 'complete' })])[1].status, 'recorded')
  const verified = { ...previousPass, harness: { ...previousPass.harness, checkedAt: '2026-10-14T08:00:10Z' } }
  assert.equal(deviceAcceptanceProgress(verified, [notice(1, { phase: 'complete' })])[1].status, 'passed')
})
