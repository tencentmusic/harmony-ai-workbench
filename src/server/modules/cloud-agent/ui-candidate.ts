import { CloudError } from './domain'

export class UiCandidateError extends CloudError {}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' && !!value.trim()

export function uiScopeComponentIssues(scope: Record<string, unknown>) {
  if (scope.status !== 'required') return []
  return (Array.isArray(scope.states) ? scope.states : []).flatMap(value => {
    const state = object(value)
    return !Array.isArray(state.components) || !state.components.length
      ? [`ui_scope/${String(state.id)} 缺少 components 及视觉断言；需按帧和源码补齐范围事实后交真人审范围，已审范围变更须重新确认，不能直接申请UI批准`] : []
  })
}

export function uiCandidateIssues(candidate: Record<string, unknown>, scope: Record<string, unknown>) {
  const issues: string[] = []
  if (candidate.status !== undefined && candidate.status !== 'ready') issues.push('UI候选仍为草稿，补齐材料后将 status 改为 ready')
  if (!['approved', 'not_applicable'].includes(String(candidate.decision))) issues.push('decision 应为 approved（提交UI基线供真人审批，不代表已经批准）或 not_applicable（确无UI）')
  if (!text(candidate.summary)) issues.push('缺少 summary 审核说明')
  if (candidate.decision === 'not_applicable') {
    if (scope.status !== 'not_applicable') issues.push('已审范围包含UI，不能申请免审')
    return issues
  }
  for (const key of ['layoutSpec', 'visualRegions']) if (!text(candidate[key])) issues.push(`缺少 ${key} 文件路径`)
  const states = Array.isArray(scope.states) ? scope.states.map(value => object(value).id).filter(text) as string[] : []
  issues.push(...uiScopeComponentIssues(scope))
  for (const key of ['baselines', 'prototypes', 'prototypeRenders', 'androidSources', 'androidEvidence']) {
    const entries = object(candidate[key])
    if (!Object.keys(entries).length || Object.keys(entries).length > 40) issues.push(`${key} 必须包含1至40项文件或证据引用`)
    for (const [name, value] of Object.entries(entries)) if (!/^[\w-]{1,100}$/.test(name) || !text(value)) issues.push(`${key}/${name} 引用无效`)
    if (['baselines', 'prototypes', 'prototypeRenders'].includes(key)) for (const state of states) if (!text(entries[state])) issues.push(`缺少 ${key}/${state}`)
    if (['baselines', 'prototypes', 'prototypeRenders'].includes(key)) for (const state of Object.keys(entries)) if (!states.includes(state)) issues.push(`${key}/${state} 不属于已审UI状态`)
  }
  return issues
}
