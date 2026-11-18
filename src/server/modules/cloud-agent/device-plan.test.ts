import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDevicePlan, extractNodeValue } from './device-plan'

const scenario = { id: 'S1', required_execution_kind: 'device_observed', actions: [{ id: 'A1', kind: 'tap', target: 'Home' }], assertions: [{ id: 'V1', action_id: 'A1', observation_kind: 'ui_snapshot', selector: 'cover', type: 'exists', expected: true }] }
const plan = () => ({ version: 1, scenarioId: 'S1', accountOrRoom: 'public home', actions: [{ id: 'A1', steps: [{ kind: 'text_tap', text: 'Home' }], bindings: [{ assertionId: 'V1', where: { id: 'cover' }, field: 'bounds' }] }] })
test('device plans bind exact canonical actions and assertions without accepting observed values', () => {
  assert.equal(parseDevicePlan(plan(), scenario).scenarioId, 'S1')
  assert.throws(() => parseDevicePlan({ ...plan(), status: 'passed' }, scenario))
  const missing = plan(); missing.actions[0].bindings = []
  assert.throws(() => parseDevicePlan(missing, scenario))
  const wrong = plan(); wrong.actions[0].id = 'OTHER'
  assert.throws(() => parseDevicePlan(wrong, scenario))
  assert.throws(() => parseDevicePlan(plan(), { ...scenario, actions: [{ id: 'A1', kind: 'network_change', target: 'wifi' }] }))
})
test('values come only from matching visible app-owned nodes; ambiguous nodes fail', () => {
  const binding = plan().actions[0].bindings[0]
  const node = { id: 'cover', visible: 'true', bundleName: 'test.app', bounds: '[1,2][3,4]' }
  assert.equal(extractNodeValue([node], binding, 'test.app'), node.bounds)
  assert.equal(extractNodeValue([{ ...node, bundleName: 'system.app' }], binding, 'test.app'), undefined)
  assert.equal(extractNodeValue([{ ...node, visible: 'false' }], binding, 'test.app'), undefined)
  assert.throws(() => extractNodeValue([node, node], binding, 'test.app'))
})
test('lifecycle actions must execute the canonical operation before observation', () => {
  for (const kind of ['home', 'back', 'launch']) {
    const canonical = { ...scenario, actions: [{ id: 'A1', kind, target: kind }] }
    const withSteps = (steps: { kind: string }[]) => ({ ...plan(), actions: [{ ...plan().actions[0], steps }] })
    assert.throws(() => parseDevicePlan(withSteps([{ kind: 'observe' }]), canonical))
    assert.throws(() => parseDevicePlan(withSteps([{ kind: kind === 'home' ? 'back' : 'home' }]), canonical))
    assert.equal(parseDevicePlan(withSteps([{ kind }, { kind: 'observe' }]), canonical).scenarioId, 'S1')
  }
})
