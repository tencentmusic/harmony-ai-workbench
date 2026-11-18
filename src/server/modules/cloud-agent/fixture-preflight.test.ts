import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireDeclaredFixtures } from './fixture-preflight'

test('only declared isolated fixture scenarios are eligible; missing mocks remain real dependencies', () => {
  const plan = { scenarios: [{ scenario_id: 'device' }, { scenario_id: 'isolated', mock_fixture: { path: 'mock.json', sha256: 'hash' }, mock_boundary: 'synthetic only' }] }
  requireDeclaredFixtures(plan, { scenario_ids: ['isolated'] })
  assert.throws(() => requireDeclaredFixtures(plan, { scenario_ids: ['device'] }), /未声明隔离.*device/)
  for (const scenario_ids of [[], ['unknown'], ['isolated', 'isolated'], [null]]) assert.throws(() => requireDeclaredFixtures(plan, { scenario_ids }))
  assert.throws(() => requireDeclaredFixtures(null, { scenario_ids: ['isolated'] }), /执行计划/)
  assert.equal(plan.scenarios[0].mock_fixture, undefined)
})
