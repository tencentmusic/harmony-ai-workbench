import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudStageForHarness, type CloudHarness } from '@/contracts/cloud-agent'

test('execution evidence failures stay in coding without changing native gates', () => {
  const status: CloudHarness = { phase: 'context_ready', checkedAt: '', branch: '', worktree: '', runDir: '', nodes: [], blockers: [{ code: 'review_scope_package_stale', message: 'stale' }], next: [], reviewPackage: '' }
  assert.equal(cloudStageForHarness(status, true), 'coding')
  assert.equal(cloudStageForHarness(status), 'analysis')
  assert.equal(status.phase, 'context_ready')
  assert.equal(status.blockers.length, 1)
  assert.equal(cloudStageForHarness({ ...status, phase: 'ui_prototype_approved' }, true), 'coding')
  assert.equal(cloudStageForHarness({ ...status, phase: 'wired' }, true), 'review')
  assert.equal(cloudStageForHarness({ ...status, phase: 'build_passed', codeReview: { status: 'passed', summary: '', findings: [], checks: [] } }, true), 'device')
})
