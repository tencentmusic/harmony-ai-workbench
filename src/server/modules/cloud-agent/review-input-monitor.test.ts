import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { monitorReviewInputs, ReviewInputsChangedError } from './review-input-monitor'

test('review monitors source drift without overlapping inspections and stops polling on close', async () => {
  let digest = 'initial', calls = 0, active = 0, maxActive = 0
  const controller = new AbortController()
  const monitor = monitorReviewInputs('initial', async () => {
    calls++; active++; maxActive = Math.max(maxActive, active)
    await delay(5); active--
    return digest
  }, controller, 5)
  await delay(30)
  assert.equal(controller.signal.aborted, false)
  digest = 'changed'
  await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
  assert.ok(monitor.error instanceof ReviewInputsChangedError)
  await monitor.close()
  const stoppedCalls = calls
  await delay(20)
  assert.equal(calls, stoppedCalls)
  assert.equal(maxActive, 1)
})

test('monitor inspection errors fail closed and do not leave unhandled rejections', async () => {
  const controller = new AbortController()
  const monitor = monitorReviewInputs('initial', async () => { throw new Error('inspection unavailable') }, controller, 5)
  await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
  assert.match(String(monitor.error), /inspection unavailable/)
  await monitor.close()
})
