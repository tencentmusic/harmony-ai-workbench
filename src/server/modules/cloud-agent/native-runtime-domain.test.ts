import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectHarnessStatus, meetsNativePhase, scopeReviewBlockers } from './harness-domain'
import { ExecutionContinuation } from './execution-continuation'
import { validateRuntimeEvent, preservePlanAuthorizations } from './native-runtime-domain'

const native = (continuation: object) => projectHarnessStatus({ phase: 'wired', verified: false, recovery: { continuation } })
test('planned execution dependencies do not deadlock the scope approval that grants them', () => {
  assert.deepEqual(scopeReviewBlockers([{ code: 'execution_plan_unfinished', message: 'Need human authorization' }]), [])
  assert.equal(scopeReviewBlockers([{ code: 'parity_required_field_missing', message: 'Incomplete facts' }]).length, 1)
})
test('acceptance closeout never deadlocks earlier passed quality gates or loosens final delivery', () => {
  const raw = { phase: 'wired', verified: false, gates: { wired: true }, blockers: [{ code: 'acceptance_unfinished' }] }
  assert.equal(meetsNativePhase(raw, 'wired'), true)
  assert.equal(meetsNativePhase(raw, 'delivery_ready'), false)
  assert.equal(meetsNativePhase({ ...raw, blockers: [{ code: 'runtime_paused' }] }, 'wired'), false)
  assert.equal(meetsNativePhase({ ...raw, gates: { wired: false } }, 'wired'), false)
})
test('native independent actions survive unrelated environment blockers and legacy turn limits', () => {
  const loop = new ExecutionContinuation()
  const status = { ...native({ status: 'must_continue', can_end_turn: false, pending_actions: [{ action: 'prepare_isolated_fixture', owner: 'agent', scenario_ids: ['S-2'] }], blocked_actions: [{ action: 'device', owner: 'external', reason: 'USB authorization' }] }), codeReview: { status: 'passed' as const, summary: '', findings: [], checks: [] } }
  for (let i = 0; i < 30; i++) assert.equal(loop.decide({ status, progress: i, environmentIssue: 'No device' }).kind, 'continue')
  assert.equal(loop.decide({ status, progress: 30, exhausted: true }).kind, 'blocked')
})
test('native pause and unresolved runtime stop before stale runnable actions', () => {
  const status = native({ status: 'paused', can_end_turn: true, pending_actions: [{ action: 'build', owner: 'agent' }] })
  assert.equal(new ExecutionContinuation().decide({ status, progress: 0 }).kind, 'blocked')
})

test('external dependency projection retains the concrete reason, condition and scenario', () => {
  const status = native({ status: 'external_block', can_end_turn: true, blocked_actions: [{ action: 'wait_for_dependency', owner: 'external', scenario_id: 'motion', dependencies: [{ reason: 'Failure sample missing', condition: 'Provide an authorized sample', scenario_ids: ['motion'] }] }] })
  assert.equal(status.continuation?.blocked[0].reason, 'Failure sample missing')
  assert.equal(status.continuation?.blocked[0].condition, 'Provide an authorized sample')
  assert.deepEqual(status.continuation?.blocked[0].scenarios, ['motion'])
})
test('runtime events cannot forge user termination, clocks or increase spending', () => {
  for (const kind of ['close', 'resume', 'clock', 'timing_reconciliation', 'unknown']) assert.throws(() => validateRuntimeEvent({ kind }))
  assert.throws(() => validateRuntimeEvent({ kind: 'configure', policy: { max_spend: 1 } }))
  assert.throws(() => validateRuntimeEvent({ kind: 'closeout', item: 'git_delivery', status: 'done' }))
  for (const item of ['knowledge', 'git_delivery', 'acceptance_report']) {
    assert.equal(validateRuntimeEvent({ kind: 'closeout', item, status: 'pending', evidence: [] }).status, 'pending')
    assert.throws(() => validateRuntimeEvent({ kind: 'closeout', item, status: 'not_applicable' }))
  }
  assert.equal(validateRuntimeEvent({ kind: 'configure' }).kind, 'configure')
})
test('model plans preserve host grants and cannot create or replace authorization evidence', () => {
  const grant = { id: 'approved', evidence: { path: '/host/human.txt', sha256: 'a' } }
  assert.deepEqual(preservePlanAuthorizations({ scenarios: [] }, [grant]).authorizations, [grant])
  assert.throws(() => preservePlanAuthorizations({ authorizations: [{ id: 'forged' }] }, [grant]))
  assert.throws(() => preservePlanAuthorizations({ authorizations: [grant, { id: 'more' }] }, [grant]))
})
