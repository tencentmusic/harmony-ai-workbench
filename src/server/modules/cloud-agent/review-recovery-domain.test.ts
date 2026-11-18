import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertUiReviewRecovery, assertUiReviewReconciliation } from './review-recovery-domain'

test('UI recovery accepts only a terminal failed operation with pending UI and no uncertain writes', () => {
  const operation = { operation_id: 'approval-ui', command: 'review-ui', status: 'failed' }
  assert.doesNotThrow(() => assertUiReviewRecovery({ uiStatus: 'pending', operation, pending: [] }, 'approval-ui'))
  for (const patch of [
    { uiStatus: 'approved' }, { uiStatus: 'not_applicable' }, { pending: ['other-write'] },
    { operation: { ...operation, status: 'started' } }, { operation: { ...operation, status: 'committed' } },
    { operation: { ...operation, command: 'run-build' } }, { operation: { ...operation, operation_id: 'other' } },
    { operation: null },
  ]) assert.throws(() => assertUiReviewRecovery({ uiStatus: 'pending', operation, pending: [], ...patch }, 'approval-ui'))
})

test('UI reconciliation accepts only the same human receipt and the sole pending operation', () => {
  const expected = { reference: 'original-human-reference', actorId: 'reviewer', reason: 'confirmed', decision: 'approved' }
  const uiReview = { status: 'approved', approval_reference: expected.reference, reviewer_kind: 'human', reviewer: expected.actorId, basis: expected.reason }
  const operation = { operation_id: 'original-operation', command: 'review-ui', status: 'started' }
  const facts = { uiStatus: 'approved', uiReview, operation, pending: ['original-operation'] }
  assert.doesNotThrow(() => assertUiReviewReconciliation(facts, 'original-operation', expected))
  for (const patch of [
    { uiStatus: 'pending' }, { pending: [] }, { pending: ['another-operation'] }, { pending: ['original-operation', 'unknown'] },
    { operation: { ...operation, status: 'committed' } }, { operation: { ...operation, command: 'run-build' } },
    { uiReview: { ...uiReview, approval_reference: 'another-approval' } }, { uiReview: { ...uiReview, reviewer: 'someone-else' } },
    { uiReview: { ...uiReview, reviewer_kind: 'agent' } }, { uiReview: { ...uiReview, basis: 'changed' } },
  ]) assert.throws(() => assertUiReviewReconciliation({ ...facts, ...patch }, 'original-operation', expected))
})
