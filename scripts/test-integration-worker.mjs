#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  createIntegrationWorkerEngine,
  recoverMissingPreparingWorktreeIfAbsent,
  resolveIntegrationWorkerConcurrency,
  startWorkerClaimHeartbeat,
} from '../src/server/modules/integration/integration-worker.ts'
import {
  shouldStartIntegrationWorker,
} from '../src/lib/instrumentation-node.ts'

assert.equal(resolveIntegrationWorkerConcurrency(undefined), 2)
assert.equal(resolveIntegrationWorkerConcurrency('1'), 1)
assert.equal(resolveIntegrationWorkerConcurrency('8'), 8)
for (const invalid of ['0', '9', '1.5', 'abc', ' 2 ']) {
  assert.throws(
    () => resolveIntegrationWorkerConcurrency(invalid),
    /HARMONY_INTEGRATION_WORKER_CONCURRENCY.*1.*8/,
  )
}

assert.equal(shouldStartIntegrationWorker({ NEXT_PHASE: 'phase-production-build' }), false)
assert.equal(shouldStartIntegrationWorker({ NEXT_PHASE: 'phase-production-server' }), true)
assert.equal(shouldStartIntegrationWorker({}), true)

{
  let scheduledTick
  let cleared = false
  const controller = new AbortController()
  const heartbeat = startWorkerClaimHeartbeat({
    runId: 'run-heartbeat',
    owner: 'worker',
    epoch: 5,
    leaseMs: 60_000,
    controller,
  }, {
    async renewIntegrationRunClaim() {
      throw new Error('lease lost')
    },
    setInterval(callback) {
      scheduledTick = callback
      return { unref() {} }
    },
    clearInterval() {
      cleared = true
    },
  })

  assert.equal(controller.signal.aborted, false)
  scheduledTick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.signal.aborted, true)
  assert.throws(
    () => heartbeat.assertActive(),
    (error) => error?.code === 'CLAIM_STALE',
  )
  await heartbeat.stop()
  assert.equal(cleared, true)
}

{
  const calls = []
  const converged = await recoverMissingPreparingWorktreeIfAbsent({
    record: {
      id: 'run-preparing-absent',
      status: 'running',
      worktreeStatus: 'preparing',
    },
    project: {
      repoRoot: '/repo',
      runtimeRoot: '/runtime',
    },
    fence: {
      runId: 'run-preparing-absent',
      owner: 'worker',
      epoch: 3,
    },
  }, {
    async cleanupIntegrationWorktree(input) {
      calls.push(['probe', input])
    },
    async failIntegrationRunExecution(input) {
      calls.push(['fail', input.errorCode])
    },
    async markIntegrationRunCleanupSafeIfTerminal() {
      calls.push(['safe'])
      return { safe: true }
    },
    async beginIntegrationRunCleanup() {
      calls.push(['begin'])
    },
    async finishIntegrationRunCleanup() {
      calls.push(['finish'])
    },
  })

  assert.equal(converged, true)
  assert.deepEqual(calls, [
    ['probe', {
      repoRoot: '/repo',
      runtimeRoot: '/runtime',
      runId: 'run-preparing-absent',
    }],
    ['fail', 'RECOVERY_INTERRUPTED'],
    ['safe'],
    ['begin'],
    ['finish'],
  ])
}

{
  const calls = []
  const converged = await recoverMissingPreparingWorktreeIfAbsent({
    record: {
      id: 'run-preparing-present',
      status: 'running',
      worktreeStatus: 'preparing',
    },
    project: {
      repoRoot: '/repo',
      runtimeRoot: '/runtime',
    },
    fence: {
      runId: 'run-preparing-present',
      owner: 'worker',
      epoch: 4,
    },
  }, {
    async cleanupIntegrationWorktree() {
      calls.push('probe')
      throw Object.assign(new Error('lock/manifest/registration still exists'), {
        code: 'WORKTREE_BUSY',
      })
    },
    async failIntegrationRunExecution() {
      calls.push('fail')
    },
    async markIntegrationRunCleanupSafeIfTerminal() {
      calls.push('safe')
      return { safe: true }
    },
    async beginIntegrationRunCleanup() {
      calls.push('begin')
    },
    async finishIntegrationRunCleanup() {
      calls.push('finish')
    },
  })

  assert.equal(converged, false)
  assert.deepEqual(calls, ['probe'])
}

{
  const calls = []
  let releaseQueued
  const queuedBarrier = new Promise((resolve) => {
    releaseQueued = resolve
  })
  const engine = createIntegrationWorkerEngine({
    pollIntervalMs: 60_000,
    async listQueuedRunIds() {
      calls.push('list:queued')
      return ['queued-1']
    },
    async listRecoveryRunIds() {
      calls.push('list:recovery')
      return ['recovery-1']
    },
    async listCleanupRunIds() {
      calls.push('list:cleanup')
      return ['cleanup-1']
    },
    async executeQueuedRun(runId) {
      calls.push(`queued:${runId}`)
      await queuedBarrier
    },
    async recoverRun(runId) {
      calls.push(`recovery:${runId}`)
    },
    async cleanupRun(runId) {
      calls.push(`cleanup:${runId}`)
    },
    onError(error, context) {
      calls.push(`error:${context.kind}:${context.runId}:${String(error)}`)
    },
  })

  const drain = engine.drainOnce()
  await new Promise((resolve) => setImmediate(resolve))
  engine.enqueue('queued-1')
  engine.enqueue('queued-1')
  releaseQueued()
  await drain
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(
    calls.filter((entry) => entry === 'queued:queued-1').length,
    1,
    'polling and API enqueue must share one in-process run fence',
  )
  assert.equal(
    calls.filter((entry) => entry === 'recovery:recovery-1').length,
    1,
  )
  assert.equal(
    calls.filter((entry) => entry === 'cleanup:cleanup-1').length,
    1,
  )
  engine.stop()
}

{
  const starts = []
  let releaseCleanup
  let releaseRecovery
  const cleanupBarrier = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const recoveryBarrier = new Promise((resolve) => {
    releaseRecovery = resolve
  })
  const engine = createIntegrationWorkerEngine({
    pollIntervalMs: 60_000,
    maxConcurrency: 1,
    async listQueuedRunIds() {
      return ['queued-low']
    },
    async listRecoveryRunIds() {
      return ['recovery-mid']
    },
    async listCleanupRunIds() {
      return ['cleanup-high']
    },
    async executeQueuedRun(runId) {
      starts.push(`queued:${runId}`)
    },
    async recoverRun(runId) {
      starts.push(`recovery:${runId}`)
      await recoveryBarrier
    },
    async cleanupRun(runId) {
      starts.push(`cleanup:${runId}`)
      await cleanupBarrier
    },
  })

  const drain = engine.drainOnce()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(starts, ['cleanup:cleanup-high'])

  releaseCleanup()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(starts, [
    'cleanup:cleanup-high',
    'recovery:recovery-mid',
  ])

  releaseRecovery()
  await drain
  assert.deepEqual(starts, [
    'cleanup:cleanup-high',
    'recovery:recovery-mid',
    'queued:queued-low',
  ])
  engine.stop()
}

{
  const errors = []
  const engine = createIntegrationWorkerEngine({
    pollIntervalMs: 60_000,
    async listQueuedRunIds() {
      return []
    },
    async listRecoveryRunIds() {
      return []
    },
    async listCleanupRunIds() {
      return []
    },
    async executeQueuedRun() {
      throw Object.assign(new Error('sensitive internal detail'), {
        code: 'RUN_FAILED',
      })
    },
    async recoverRun() {},
    async cleanupRun() {},
    onError(error, context) {
      errors.push({
        code: error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'UNKNOWN',
        ...context,
      })
    },
  })

  engine.enqueue('queued-error')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(errors, [{
    code: 'RUN_FAILED',
    kind: 'queued',
    runId: 'queued-error',
  }])
  engine.stop()
}

const instrumentationSource = readFileSync(
  path.resolve(import.meta.dirname, '../src/lib/instrumentation-node.ts'),
  'utf8',
)
assert.match(instrumentationSource, /startIntegrationWorker/)

const workerSource = readFileSync(
  path.resolve(import.meta.dirname, '../src/server/modules/integration/integration-worker.ts'),
  'utf8',
)
assert.match(
  workerSource,
  /async function cleanupRun[\s\S]*startWorkerClaimHeartbeat[\s\S]*finally\s*\{[\s\S]*claimHeartbeat\.stop\(\)/,
)
assert.match(
  workerSource,
  /async function cleanupRun[\s\S]*reclaimIntegrationWorktreeLeaseForCleanup\(lease\)/,
  'cleanup retries must reclaim both active and cleanup_pending manifests',
)

console.log('integration worker tests passed')
