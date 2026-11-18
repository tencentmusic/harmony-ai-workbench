import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSourceApproval } from './harness-domain'

const approval = { verified: false, gates: { scope_approved: true, ui_prototype_approved: true } }
test('approved work remains editable while engineering evidence needs repair', () => {
  for (const code of ['unaccounted_harmony_changes', 'large_change_requires_approval', 'static_source_stale', 'build_source_stale']) {
    assert.doesNotThrow(() => assertSourceApproval({ ...approval, blockers: [{ code, message: 'repair pending' }] }))
  }
})
test('missing or stale approval, native pause and uncertain operations still stop all writes', () => {
  for (const value of [{}, { ...approval, authoritative: false }, { ...approval, gates: { scope_approved: true } }, { ...approval, gates: { scope_approved: false, ui_prototype_approved: true } }]) assert.throws(() => assertSourceApproval(value))
  for (const code of ['runtime_inspection_failed', 'run_busy', 'operation_in_doubt', 'runtime_paused', 'runtime_waiting']) assert.throws(() => assertSourceApproval({ ...approval, blockers: [{ code, message: 'stop' }] }), /暂不能写入/)
})
