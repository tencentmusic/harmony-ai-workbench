import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionEntries, executionLabel, isExecutionError, humanInputReason } from './execution-progress'
import type { CloudEvent } from '@/contracts/cloud-agent'

const event = (id: number, kind: string, message: string, runId = 'current'): CloudEvent => ({ id, kind, message, runId, taskId: 'task', createdAt: '2026-09-29T09:00:00Z' })
test('human input displays only the current run explicit question, never model prose or old requests', () => {
  const events = [event(1, 'continuation', '需要补充外部事实：旧问题', 'old'), event(2, 'output', '需要补充外部事实：模型文字'), event(3, 'continuation', '需要补充外部事实：请确认录屏版本')]
  assert.equal(humanInputReason(events, 'current'), '请确认录屏版本')
  assert.equal(humanInputReason(events), '')
})
test('execution timeline isolates runs, deduplicates and interleaves streamed text with tools', () => {
  const input = [event(1, 'tool', 'old', 'old'), event(3, 'output', 'B'), event(2, 'output', 'A'), event(4, 'tool', '调用 source_read'), event(5, 'output', 'C'), event(5, 'output', 'C')]
  assert.deepEqual(executionEntries(input, 'current').map(row => row.message), ['AB', '调用 source_read', 'C'])
  assert.equal(input[2].message, 'A')
  assert.deepEqual(executionEntries(input), [])
  assert.equal(isExecutionError(event(6, 'tool', 'harness_record：不得修改人工审批字段')), true)
  assert.match(executionLabel('调用 source_read'), /开始读取源码/)
})
