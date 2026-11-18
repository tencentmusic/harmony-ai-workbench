import { CloudError, record } from './domain'

export function requireDeclaredFixtures(plan: Record<string, unknown> | null, payload: Record<string, unknown>) {
  if (!plan) throw new CloudError('请先登记执行计划，不可直接生成场景样本', 409)
  const selected = payload.scenario_ids
  if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string') || new Set(selected).size !== selected.length) throw new CloudError('请提供不重复的 scenario_ids')
  const rows = (Array.isArray(plan.scenarios) ? plan.scenarios : []).map(record)
  const eligible = rows.filter(row => row.mock_fixture != null).map(row => row.scenario_id)
  const invalid = selected.filter(id => !eligible.includes(id))
  if (invalid.length) throw new CloudError(`场景未声明隔离 mock_fixture：${invalid.join('、')}。当前可准备：${eligible.join('、') || '无'}。真机场景应登记对应数据依赖并执行真实验证；确需隔离样本时，先在执行计划登记有效 mock_fixture 与 mock_boundary，不修改已审预期、不把样本当作验收通过。此问题不阻止独立构建。`, 409)
}
