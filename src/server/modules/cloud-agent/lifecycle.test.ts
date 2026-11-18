import assert from 'node:assert/strict'
import test from 'node:test'
import { executionLifecycle, cloudStageForHarness, type CloudHarness } from '@/contracts/cloud-agent'
import { legacyLifecycle } from './lifecycle'

const status: CloudHarness = { phase: 'wired', checkedAt: '', branch: '', worktree: '', runDir: '', nodes: [{ id: 'implemented', label: '', status: 'passed' }, { id: 'wired', label: '', status: 'passed' }], blockers: [], next: [], reviewPackage: '', codeReview: { status: 'passed', summary: '', checks: [], findings: [] } }
test('build repair keeps lifecycle while native evidence remains invalid', () => {
  const prior = executionLifecycle(status, 1)
  assert.equal(prior.stage, 'build')
  const invalid = { ...status, phase: 'ui_prototype_approved', nodes: [], codeReview: undefined }
  const before = JSON.stringify(invalid)
  const repair = executionLifecycle(invalid, 1, prior)
  assert.equal(repair.stage, 'build')
  assert.equal(repair.reviewPassed, true)
  assert.ok(repair.passedNodes.includes('wired'))
  assert.equal(cloudStageForHarness(invalid, true), 'coding')
  assert.equal(JSON.stringify(invalid), before)
  assert.equal(executionLifecycle(invalid, 2, prior).stage, 'coding')
})
test('device repair and resumed build retain only an execution lifecycle', () => {
  const device = executionLifecycle({ ...status, phase: 'build_passed' }, 1)
  assert.equal(device.stage, 'device')
  assert.equal(executionLifecycle({ ...status, codeReview: undefined }, 1, device).stage, 'device')
  assert.equal(executionLifecycle({ ...status, phase: 'ui_prototype_approved', codeReview: undefined }, 1, undefined, 'build').stage, 'build')
  assert.equal(executionLifecycle({ ...status, phase: 'ui_prototype_approved', codeReview: undefined }, 1, undefined, 'integration').stage, 'coding')
})

test('only host stage events recover historical passes, never model prose', () => {
  const invalid = { ...status, phase: 'ui_prototype_approved', nodes: [], codeReview: undefined }
  const recovered = legacyLifecycle(invalid, 1, ['当前执行：构建验证。按当前已验证门禁继续执行'])
  assert.equal(recovered.stage, 'build')
  assert.equal(recovered.reviewPassed, true)
  assert.ok(recovered.passedNodes.includes('wired'))
  assert.equal(legacyLifecycle(invalid, 1, ['我已完成构建验证']).stage, 'coding')
})
