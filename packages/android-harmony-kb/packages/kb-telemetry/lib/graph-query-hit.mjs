/** L2 代码图谱：统一「有效命中」判定（ROI 口径） */

export function countCodegraphResults(result) {
  if (result == null) return 0

  let value = result
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    try {
      value = JSON.parse(trimmed)
    } catch {
      return trimmed.length > 0 ? 1 : 0
    }
  }

  if (typeof value !== 'object') return 0
  if (value.error) return 0

  for (const key of ['hits', 'callers', 'callees', 'impacted', 'nodes', 'files', 'modules', 'edges']) {
    if (Array.isArray(value[key]) && value[key].length > 0) return value[key].length
  }

  if (value.node && typeof value.node === 'object') return 1
  if (value.ready === true || value.status === 'ready' || value.indexed === true) return 1
  if (typeof value.total_files === 'number' && value.total_files > 0) return value.total_files

  return 0
}

export function isGraphQueryHitFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.hit === true || payload.hit === 'true' || payload.hit === 1 || payload.hit === '1') return true
  if (payload.hit === false || payload.hit === 'false' || payload.hit === 0 || payload.hit === '0') return false
  if (payload.error) return false
  const count = Number(payload.result_count)
  return Number.isFinite(count) && count > 0
}

export function graphQueryHitFields(result, extra = {}) {
  const resultCount = countCodegraphResults(result)
  const error = result && typeof result === 'object' ? result.error || null : null
  const hit = resultCount > 0 && !error
  return {
    ...extra,
    result_count: resultCount,
    hit,
    error,
  }
}

/** SQLite 片段：kb.graph_query 有效命中 */
export const GRAPH_QUERY_HIT_SQL = `(event_type = 'kb.graph_query' AND (
  json_extract(payload_json, '$.hit') IN ('true', '1')
  OR CAST(json_extract(payload_json, '$.result_count') AS INTEGER) > 0
) AND COALESCE(json_extract(payload_json, '$.error'), '') = '')`
