import assert from 'node:assert/strict'
import test from 'node:test'
import { stoppedAcceptanceIntervals } from './acceptance-idle-reconciliation'

const events = [
  { id: 1, runId: 'a', kind: 'tool', message: '设备动作未决', at: 1000 },
  { id: 2, runId: 'a', kind: 'harness_waiting', message: '工具未确认结束', at: 2000 },
  { id: 3, runId: 'a', kind: 'recovered', message: '旧进程已停止', at: 200000 },
  { id: 4, runId: 'a', kind: 'resume_translation', message: '继续', at: 300000 },
  { id: 5, runId: 'b', kind: 'harness_waiting', message: '会话停止', at: 301000 },
  { id: 6, runId: 'b', kind: 'resume_translation', message: '继续', at: 500000 },
]

test('operator reconciliation bounds stopped time and leaves an unsettled tool cushion', () => {
  assert.deepEqual(stoppedAcceptanceIntervals(events, [{ startedAt: new Date(1000).toISOString(), status: 'stopped' }], 0, 600000), [[181, 300], [301, 500]])
})

test('operator reconciliation rejects process activity and incomplete process receipts', () => {
  assert.throws(() => stoppedAcceptanceIntervals(events, [{ startedAt: new Date(250000).toISOString(), status: 'stopped' }], 0, 600000), /子进程/)
  assert.throws(() => stoppedAcceptanceIntervals(events, [{ startedAt: new Date(1000).toISOString(), status: 'uncertain' }], 0, 600000), /未全部结算/)
  assert.throws(() => stoppedAcceptanceIntervals(events, [], 0, 600000), /缺少 Harness/)
  assert.deepEqual(stoppedAcceptanceIntervals([...events.slice(0, 3), { id: 7, runId: 'a', kind: 'tool', message: '调用设备', at: 250000 }, ...events.slice(3)], [{ startedAt: new Date(1000).toISOString(), status: 'stopped' }], 0, 600000), [[301, 500]])
})
