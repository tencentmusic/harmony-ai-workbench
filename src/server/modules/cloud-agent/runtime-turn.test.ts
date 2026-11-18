import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCompletedModelTurn } from './runtime-turn'

test('empty unknown completion reaches the controller instead of waiting for an idle timeout', () => {
  const message = { info: { id: 'empty', time: { completed: 123 }, finish: 'unknown' }, parts: [{ type: 'step-start' }, { type: 'step-finish', reason: 'unknown' }] }
  assert.equal(isCompletedModelTurn(message), true)
  assert.equal(isCompletedModelTurn({ ...message, parts: [{ type: 'reasoning', text: 'fixture' }] }), true)
})
test('unfinished model or tool work is not a completed turn', () => {
  assert.equal(isCompletedModelTurn(undefined), false)
  assert.equal(isCompletedModelTurn({ info: { time: {} }, parts: [{ type: 'text', text: 'still streaming' }] }), false)
  assert.equal(isCompletedModelTurn({ info: { time: { completed: 123 }, finish: 'tool-calls' }, parts: [{ type: 'tool', state: { status: 'completed' } }] }), false)
  for (const status of ['pending', 'running']) assert.equal(isCompletedModelTurn({ info: { time: { completed: 123 }, finish: 'stop' }, parts: [{ type: 'tool', state: { status } }] }), false)
  assert.equal(isCompletedModelTurn({ info: { time: { completed: 123 }, error: { name: 'APIError' } }, parts: [] }), false)
})
