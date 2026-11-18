import { HARNESS_PHASES, type CloudHarness } from '@/contracts/cloud-agent'
import { CloudError, record } from './domain'
import { projectRuntime } from './native-runtime-domain'
import { patchChangeLedger, withoutChangeDecisions } from './change-patch'

export function meetsNativePhase(value: unknown, minimum: string) {
  const row = record(value)
  if (minimum === 'delivery_ready') return row.verified === true
  const required = HARNESS_PHASES.findIndex(([id]) => id === minimum), current = HARNESS_PHASES.findIndex(([id]) => id === row.phase)
  if (row.authoritative === false || typeof row.verified !== 'boolean' || required < 0 || current < required || record(row.gates || {})[minimum] !== true) return false
  // Acceptance scheduling can hold final delivery without revoking earlier quality gates.
  return ![row.blockers].flatMap(value => Array.isArray(value) ? value.map(record) : []).some(issue => !['acceptance_unfinished', 'execution_plan_unfinished'].includes(String(issue.code)))
}

export function assertSourceApproval(value: unknown) {
  const row = record(value), gates = record(row.gates || {})
  const issues = Array.isArray(row.blockers) ? row.blockers.map(record) : []
  const paused = issues.find(issue => ['runtime_inspection_failed', 'run_busy', 'operation_in_doubt', 'runtime_paused', 'runtime_waiting'].includes(String(issue.code)))
  if (paused) throw new CloudError(`当前 Harness 暂不能写入：[${paused.code}] ${paused.message}`, 409)
  // Overall verified also requires implementation/build evidence; those failures must remain repairable.
  if (row.authoritative === false || typeof row.verified !== 'boolean' || gates.scope_approved !== true || gates.ui_prototype_approved !== true) {
    throw new CloudError(`Scope/UI 人工门禁尚未通过，不允许写业务源码：${issues.map(issue => `[${issue.code}] ${issue.message}`).join('；').slice(0, 2000) || '缺少当前有效的原生批准'}`, 409)
  }
}

export function scopeReviewBlockers(blockers: CloudHarness['blockers']) {
  // These refer to the decision being requested, not missing engineering facts.
  const awaitingDecision = new Set(['review_scope_pending', 'review_scope_package_stale', 'review_scope_not_presented', 'review_scope_presented_artifact', 'execution_plan_unfinished', 'acceptance_unfinished'])
  return blockers.filter(issue => !awaitingDecision.has(issue.code))
}

export function reviewGateFailure(status: Pick<CloudHarness, 'phase' | 'blockers' | 'next'>) {
  const detail = status.blockers.length ? status.blockers.map(issue => `[${issue.code}] ${issue.message}`).join('；')
    : `当前阶段 ${status.phase}；${status.next.join('；') || '原生校验未达到本次审批要求，请检查当前范围材料'}`
  return new CloudError(`人工决定已保存，门禁校验未通过：${detail.slice(0, 3000)}`, 409)
}

export function validateCapabilities(value: unknown) {
  const row = record(value), schema = record(row.artifact_schema), quality = record(row.quality_contract), gates = record(row.gate_versions)
  const commands = row.commands
  if (row.protocol_version !== 1 || row.implementation_id !== 'unified-harness-v2' || quality.version !== 1 ||
    !Array.isArray(schema.readable) || !schema.readable.includes(schema.current) || !schema.readable.includes(3) || !Array.isArray(schema.writable) || !schema.writable.includes(3) ||
    !Array.isArray(commands) || ['start', 'resume', 'verify', 'record-context', 'record-evidence', 'record-parity', 'record-change', 'record-static'].some(command => !commands.includes(command)) ||
    !Array.isArray(row.phases) || row.phases.length !== HARNESS_PHASES.length || HARNESS_PHASES.some(([phase], i) => (row.phases as unknown[])[i] !== phase) ||
    Object.entries({ change_scope: 1, delivery: 1, execution_discipline: 1, interaction_contract: 1, post_implementation_visual: 1, ui_review: 2, visual_comparison_policy: 2 }).some(([key, version]) => gates[key] !== version)) throw new CloudError('Harness 协议、阶段或门禁版本不兼容', 503)
  const files = record(quality.engine_files)
  const preflight = record(row.execution_preflight || {}), acceptance = record(row.acceptance || {})
  if (preflight.version !== 1 || acceptance.version !== 1 || !Array.isArray(preflight.actions) || ['execution-plan', 'prepare-fixtures', 'android-reference'].some(action => !(preflight.actions as unknown[]).includes(action)) || !row.device_preparation) throw new CloudError('需要支持执行计划、设备准备和验收预算的 Harness 1.6', 503)
  for (const name of ['migration_harness.py', 'harness_delivery.py', 'harness_execution.py', 'harness_review.py', 'harness_runtime.py', 'harness_visual_provenance.py', 'harness_preflight.py', 'harness_acceptance.py', 'harness_device.py']) if (typeof files[name] !== 'string' || !/^[a-f0-9]{64}$/.test(files[name] as string)) throw new CloudError('Harness 引擎指纹不完整', 503)
  return row
}
export function projectHarnessStatus(value: unknown): CloudHarness {
  const row = record(value)
  const index = HARNESS_PHASES.findIndex(([id]) => id === row.phase)
  if (index < 0 || row.authoritative === false || typeof row.verified !== 'boolean') throw new CloudError('Harness 未返回严格验证结果', 503)
  const blockers = [row.blockers, row.delivery_blockers].flatMap(items => Array.isArray(items) ? items.map(item => { const issue = record(item); return { code: String(issue.code || ''), message: String(issue.message || '') } }) : [])
  const gates = record(row.gates || {})
  return { ...projectRuntime(row.recovery), phase: String(row.phase), checkedAt: new Date().toISOString(), branch: '', worktree: '', runDir: '',
    nodes: HARNESS_PHASES.map(([id, label], i) => ({ id, label, status: gates[id] === true || i <= index ? 'passed' : i === index + 1 && blockers.length ? 'blocked' : 'pending' })),
    blockers, next: Array.isArray(row.next_actions) ? row.next_actions.filter((item): item is string => typeof item === 'string') : [], reviewPackage: typeof row.review_package === 'string' ? row.review_package : '' }
}
export function assertCandidatePayload(value: unknown) {
  if (Array.isArray(value)) { value.forEach(assertCandidatePayload); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/^(approval|ui_review|reviewer|approved_by|approval_evidence|approval_reference|human_decision)$/.test(key) ||
      (key === 'status' && ['approved', 'passed', 'accepted_with_differences'].includes(String(item)))) throw new CloudError('Agent 不可登记人工批准或验收通过；请通过人工审核和真实执行收据登记', 403)
    assertCandidatePayload(item)
  }
}

export function agentRecordPayload(existing: Record<string, unknown>, payload: Record<string, unknown>, command?: string) {
  const candidate = command === 'record-change' ? patchChangeLedger(existing, payload) : { ...payload }
  const preserved: Record<string, unknown> = {}
  // Native record commands replace ledgers, so omitted human decisions must survive.
  for (const key of ['approval', 'ui_review', 'scope_approval', 'test_exclusions']) {
    if (Object.hasOwn(candidate, key)) {
      if (!Object.hasOwn(existing, key) || JSON.stringify(candidate[key]) !== JSON.stringify(existing[key])) throw new CloudError('不得修改人工审批字段', 403)
      delete candidate[key]
    }
    if (Object.hasOwn(existing, key)) preserved[key] = existing[key]
  }
  const validation = { ...candidate }
  if (command === 'record-change') {
    if (candidate.change_scope) validation.change_scope = withoutChangeDecisions(candidate.change_scope)
    const audit = record(candidate.skeleton_audit || {})
    if (audit.status === 'passed') {
      if (['zero_callers', 'zero_consumers', 'write_only_fields'].some(key => !Array.isArray(audit[key]) || audit[key].length !== 0) ||
        typeof audit.notes !== 'string' || !audit.notes.trim()) throw new CloudError('调用链自检需明确核销零调用、零消费、只写字段，并填写核查说明；未完成时保持 pending', 409)
      validation.skeleton_audit = { ...audit, status: 'pending' }
    }
    // Exempt only exact source self-check paths; native verification still proves wired.
    if (Array.isArray(candidate.reachability)) validation.reachability = candidate.reachability.map(item => {
      const chain = record(item)
      return chain.status === 'passed' ? { ...chain, status: 'pending' } : item
    })
  }
  assertCandidatePayload(validation)
  return { ...candidate, ...preserved }
}
