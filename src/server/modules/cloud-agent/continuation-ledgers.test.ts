import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentRecordPayload } from './harness-domain'

const decision = { excluded_paths: [{ path: 'sign/debug.cer', reviewer_kind: 'human', approval_reference: 'operations/approved.md' }], large_change_approval: null }
const ledger = { changes: [{ id: 'C1', files: ['old'], status: 'implemented' }, { id: 'C2', files: ['other'] }], reachability: [{ parity_id: 'P1', status: 'passed', proof: { entry: 'existing' } }], change_scope: decision }

test('partial record-change preserves unrelated entries, reachability and human exclusions', () => {
  const patch = { changes: [{ id: 'C1', files: ['new'] }] }
  const result = agentRecordPayload(ledger, patch, 'record-change')
  assert.deepEqual(result, { ...ledger, changes: [{ ...ledger.changes[0], files: ['new'] }, ledger.changes[1]] })
  assert.deepEqual(ledger.changes[0].files, ['old'])
  assert.deepEqual(agentRecordPayload(ledger, { changes: [], reachability: [] }, 'record-change'), ledger)
})

test('existing human exclusions may be echoed or omitted but never changed by an agent', () => {
  assert.deepEqual(agentRecordPayload(ledger, { change_scope: decision }, 'record-change'), ledger)
  assert.deepEqual(agentRecordPayload(ledger, { change_scope: {} }, 'record-change'), ledger)
  for (const scope of [null, { excluded_paths: [] }, { excluded_paths: [{ ...decision.excluded_paths[0], path: 'business.ets' }] }, { large_change_approval: { status: 'approved' } }]) {
    assert.throws(() => agentRecordPayload(ledger, { change_scope: scope }, 'record-change'), /人工/)
  }
  assert.throws(() => agentRecordPayload({}, { change_scope: decision }, 'record-change'), /人工/)
  assert.throws(() => agentRecordPayload(ledger, { arbitrary: { approval_reference: 'fake' } }, 'record-change'), /人工/)
})

test('change patches reject malformed or duplicate keys without silently dropping evidence', () => {
  for (const changes of [null, {}, [{ files: [] }], [{ id: 'C1' }, { id: 'C1' }]]) {
    assert.throws(() => agentRecordPayload(ledger, { changes }, 'record-change'))
  }
  assert.deepEqual(agentRecordPayload({}, { change_scope: { excluded_paths: [], large_change_approval: null } }, 'record-change').change_scope, { excluded_paths: [], large_change_approval: null })
})
