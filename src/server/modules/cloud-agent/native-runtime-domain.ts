import type { CloudHarness, CloudHarnessAction } from '@/contracts/cloud-agent'
import { CloudError, record } from './domain'

const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 200) : []
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 2000) : ''
export function projectRuntime(value: unknown): Pick<CloudHarness, 'continuation' | 'acceptance' | 'preflight'> {
  const raw = record(value || {}), continuation = record(raw.continuation || {}), preflight = record(raw.execution_preflight || {}), acceptance = record(raw.acceptance || {})
  const actions = (value: unknown): CloudHarnessAction[] => Array.isArray(value) ? value.slice(0, 200).map(item => {
    const row = record(item)
    const dependencies = Array.isArray(row.dependencies) ? row.dependencies.slice(0, 200).map(record) : []
    return { action: text(row.action), owner: text(row.owner),
      reason: text([text(row.reason) || strings(row.reasons).join('; '), ...dependencies.map(dep => text(dep.reason))].filter(Boolean).join('; ')),
      condition: text([text(row.condition), ...dependencies.map(dep => text(dep.condition))].filter(Boolean).join('; ')),
      scenarios: [...new Set([...strings(row.scenario_ids), ...(text(row.scenario_id) ? [text(row.scenario_id)] : []), ...dependencies.flatMap(dep => strings(dep.scenario_ids))])].slice(0, 200) }
  }) : []
  const schedule = record(continuation.scenario_schedule || {})
  return {
    ...(typeof continuation.can_end_turn === 'boolean' && typeof continuation.status === 'string' ? { continuation: {
      status: continuation.status, canEndTurn: continuation.can_end_turn, reason: text(continuation.stop_reason),
      pending: actions(continuation.pending_actions), blocked: actions(continuation.blocked_actions), readyScenarios: strings(schedule.ready_scenario_ids), diagnosisScenarios: strings(schedule.diagnosis_scenario_ids),
    } } : {}),
    ...(typeof preflight.configured === 'boolean' ? { preflight: { configured: preflight.configured, digest: text(preflight.plan_sha256) } } : {}),
    ...(typeof acceptance.configured === 'boolean' ? { acceptance: { configured: acceptance.configured, exhausted: acceptance.run_budget_exhausted === true, pendingIssues: strings(acceptance.pending_issue_ids), closeoutMissing: strings(acceptance.closeout_missing) } } : {}),
  }
}
export function preservePlanAuthorizations(value: unknown, grants: unknown[]) {
  const plan = record(value)
  if (plan.authorizations !== undefined && JSON.stringify(plan.authorizations) !== JSON.stringify(grants)) throw new CloudError('执行计划授权只能由真人审核登记；省略 authorizations 以复用既有授权', 403)
  const { requested_authorizations: requested, ...payload } = plan
  if (requested !== undefined) throw new CloudError('新增授权须写入 candidates/execution-plan.json 随范围审核展示', 403)
  return { ...payload, authorizations: grants }
}
export function validateRuntimeEvent(value: unknown) {
  const event = record(value)
  if (!['configure', 'start', 'finish', 'block', 'reopen', 'score', 'closeout'].includes(String(event.kind))) throw new CloudError('此验收事件不允许由 Agent 登记', 403)
  if (event.kind === 'configure') {
    if (event.policy !== undefined && JSON.stringify(event.policy) !== '{}') throw new CloudError('验收预算由平台配置，Agent 不可覆盖', 403)
    if (event.spend_authorization !== undefined || event.authorization_evidence !== undefined) throw new CloudError('Agent 不可授予消费额度', 403)
  }
  if (event.kind === 'closeout' && ['git_delivery', 'knowledge', 'acceptance_report'].includes(String(event.item)) && event.status !== 'pending') throw new CloudError('Git、知识产物和验收报告的完成收尾由 harness_finalize 核验；外部依赖可登记有真实证据的 pending', 403)
  return event
}
