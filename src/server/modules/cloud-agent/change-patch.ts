import { isDeepStrictEqual } from 'node:util'
import { CloudError, record } from './domain'

function upsert(previous: unknown, incoming: unknown, key: string) {
  if (!Array.isArray(incoming)) throw new CloudError(`变更补录必须提供数组，按 ${key} 更新`, 409)
  const rows = new Map<string, Record<string, unknown>>()
  for (const values of [Array.isArray(previous) ? previous : [], incoming]) {
    const seen = new Set<string>()
    for (const value of values) {
      const item = record(value), id = item[key]
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) throw new CloudError(`变更补录缺少或重复 ${key}，请重读完整账本`, 409)
      seen.add(id)
      rows.set(id, { ...rows.get(id), ...item })
    }
  }
  return [...rows.values()]
}

export function patchChangeLedger(existing: Record<string, unknown>, payload: Record<string, unknown>) {
  const result = { ...existing, ...payload }
  for (const [field, key] of [['changes', 'id'], ['reachability', 'parity_id']]) {
    if (Object.hasOwn(payload, field)) result[field] = upsert(existing[field], payload[field], key)
  }
  if (Object.hasOwn(payload, 'change_scope') && (!payload.change_scope || typeof payload.change_scope !== 'object' || Array.isArray(payload.change_scope))) throw new CloudError('不得删除人工变更范围依据', 403)
  if (existing.change_scope || payload.change_scope) {
    const before = record(existing.change_scope || {}), incoming = record(payload.change_scope || {})
    for (const field of ['excluded_paths', 'large_change_approval']) {
      const empty = field === 'excluded_paths' ? [] : null
      if (Object.hasOwn(incoming, field) && !isDeepStrictEqual(incoming[field], Object.hasOwn(before, field) ? before[field] : empty)) throw new CloudError('不得修改人工变更范围依据，请通过人工或运维流程处理', 403)
    }
    result.change_scope = { ...before, ...incoming }
  }
  return result
}

export function withoutChangeDecisions(value: unknown) {
  const scope = { ...record(value) }
  delete scope.excluded_paths
  delete scope.large_change_approval
  return scope
}
