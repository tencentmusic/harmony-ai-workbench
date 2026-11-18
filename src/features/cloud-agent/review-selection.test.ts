import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudTask, CloudReview } from '@/contracts/cloud-agent'
import { approvalOptions, selectedApproval, isPendingReview } from './review-selection'

const scope: CloudReview = { kind: 'scope', digest: 'scope', materialVersion: 1, content: 'Scope', decision: 'approved', files: [] }
const ui: CloudReview = { ...scope, kind: 'ui', digest: 'ui' }
const task = { status: 'translating', materialVersion: 1, actions: [], runs: [{ materialVersion: 1 }], review: null, approvedReviews: [scope, ui] } as unknown as CloudTask
test('coding defaults to approved UI, scope remains selectable and both are read-only', () => {
  assert.equal(selectedApproval(task), ui)
  assert.equal(selectedApproval(task, 'scope'), scope)
  assert.equal(isPendingReview(task, ui), false)
  assert.equal(selectedApproval({ ...task, materialVersion: 2 }), null)
})
test('new pending review takes priority and historical review can never approve it', () => {
  const fresh = { ...ui, digest: 'new-ui' }
  const pending = { ...task, status: 'awaiting_approval', actions: ['approve'], review: fresh } as CloudTask
  assert.deepEqual(approvalOptions(pending), [scope, fresh])
  assert.equal(selectedApproval(pending), fresh)
  assert.equal(isPendingReview(pending, fresh), true)
  assert.equal(isPendingReview(pending, scope), false)
  assert.equal(isPendingReview(pending, ui), false)
  assert.equal(selectedApproval({ ...task, review: { ...fresh, kind: 'visual' } }), ui)
})
