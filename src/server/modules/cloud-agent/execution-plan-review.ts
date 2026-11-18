import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { HarnessWorkspace } from './harness'
import { CloudError, record } from './domain'
import { runtimeJson, savedPlan, invokeRuntime, runtimeEvidence, hostGrants } from './native-runtime'
import { UiCandidateError } from './ui-candidate'

export function requestedGrants(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 30) throw new UiCandidateError('执行授权申请必须是不超过30项的数组')
  const ids = new Set<string>()
  return value.map(item => {
    const g = record(item)
    const text = (key: string) => { const v = g[key]; if (typeof v !== 'string' || !v.trim() || v.length > 300) throw new UiCandidateError(`执行授权缺少 ${key}`); return v }
    const id = text('id')
    if (!/^[\w-]{1,80}$/.test(id) || ids.has(id)) throw new UiCandidateError('执行授权ID重复或非法')
    ids.add(id)
    if (!Array.isArray(g.scenario_ids) || !g.scenario_ids.length || !g.scenario_ids.every(s => typeof s === 'string' && /^[\w-]{1,100}$/.test(s))) throw new UiCandidateError('执行授权需要明确场景ID')
    if (!Array.isArray(g.effects) || !g.effects.length || !g.effects.every(e => ['read_only', 'navigation', 'account_write', 'publish', 'delete', 'paid'].includes(e))) throw new UiCandidateError('执行授权需要明确操作类别')
    if (!Number.isSafeInteger(g.max_spend ?? 0) || Number(g.max_spend ?? 0) < 0) throw new UiCandidateError('授权额度必须为非负整数最小货币单位')
    if (g.effects.includes('paid') && (!g.max_spend || typeof g.currency !== 'string' || !/^[A-Z]{3}$/.test(g.currency))) throw new UiCandidateError('消费授权需要金额上限与三位币种')
    return { id, scenario_ids: g.scenario_ids, effects: g.effects, account_ref: text('account_ref'), target_ref: text('target_ref'), max_spend: g.max_spend ?? 0, ...(g.currency ? { currency: text('currency') } : {}) }
  })
}
export async function reviewExecutionPlan(workspace: HarnessWorkspace) {
  const plan = await savedPlan(workspace)
  if (!plan) {
    if (workspace.runtimeVersion) throw new UiCandidateError('尚未登记执行计划：请调用 harness_execution_plan 盘点全部场景依赖及替代方式')
    return undefined
  }
  const candidate = await runtimeJson(workspace, 'candidates/execution-plan.json')
  const requested = requestedGrants(candidate?.requested_authorizations)
  const scenarios = Array.isArray(plan.scenarios) ? plan.scenarios.map(row => String(record(row).scenario_id)) : []
  if (requested.some(g => (g.scenario_ids as string[]).some(id => !scenarios.includes(id)))) throw new UiCandidateError('授权申请包含未登记场景')
  const currencies = new Set(requested.filter(g => (g.effects as string[]).includes('paid')).map(g => g.currency))
  if (currencies.size > 1) throw new UiCandidateError('同一任务的消费授权必须使用同一币种')
  return { plan, requested }
}
export async function approveExecutionPlan(workspace: HarnessWorkspace, review: { plan: Record<string, unknown>; requested: Record<string, unknown>[] }, evidence: { path: string; sha256: string }, operationId: string, signal: AbortSignal) {
  const previous = (await hostGrants(workspace)).map(record)
  const grants = [...previous.filter(g => !review.requested.some(r => r.id === g.id)), ...review.requested.map(g => ({ ...g, evidence }))]
  await invokeRuntime(workspace, 'execution-plan', await runtimeEvidence(workspace, { ...review.plan, authorizations: grants }), operationId, signal)
  await writeFile(path.join(workspace.artifactRoot, 'approvals/execution-grants.json'), JSON.stringify({ identity: workspace.identity, grants }), { mode: 0o600 })
}
