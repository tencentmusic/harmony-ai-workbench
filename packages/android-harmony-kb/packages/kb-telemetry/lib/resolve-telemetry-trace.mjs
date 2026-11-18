import { lookupHostSession, readAllBindings } from './trace-registry.mjs'

function hostSessionCandidates(options = {}) {
  const fromReq = options.hostSessionId || options.opencodeSessionId || options.sessionId
  const fromEnv = [
    process.env.KB_TELEMETRY_HOST_SESSION_ID,
    process.env.OPENCODE_SESSION_ID,
    process.env.OPENCODE_SESSION,
  ]
  const ids = []
  if (fromReq) ids.push(String(fromReq).trim())
  for (const id of fromEnv) {
    const s = String(id || '').trim()
    if (s && !ids.includes(s)) ids.push(s)
  }
  return ids
}

/** 将 MCP / 独立进程上报的事件绑定到工台 trace（OpenCode session → trace-registry）。 */
export function resolveTelemetryTrace(options = {}) {
  const env = options.env || process.env
  for (const hostSessionId of hostSessionCandidates(options)) {
    const bound = lookupHostSession(hostSessionId, env)
    if (bound?.traceId && bound?.turnId) {
      return {
        traceId: bound.traceId,
        turnId: bound.turnId,
        consumer: bound.consumer || options.consumer || env.KB_TELEMETRY_CONSUMER || 'mcp-direct',
        featureId: bound.featureId || options.featureId || null,
        hostSessionId,
      }
    }
  }

  const maxAgeMs = Number(options.maxBindingAgeMs ?? 45 * 60 * 1000)
  const all = readAllBindings(env)
  const entries = Object.entries(all)
    .map(([hostSessionId, row]) => ({
      hostSessionId,
      traceId: String(row?.trace_id || ''),
      turnId: String(row?.turn_id || ''),
      consumer: String(row?.consumer || ''),
      featureId: row?.feature_id || null,
      boundAt: Date.parse(String(row?.bound_at || '')) || 0,
    }))
    .filter((e) => e.traceId && e.turnId && e.boundAt > 0)
    .sort((a, b) => b.boundAt - a.boundAt)

  if (!entries.length) return null

  const latest = entries[0]
  if (Date.now() - latest.boundAt <= maxAgeMs) {
    return {
      traceId: latest.traceId,
      turnId: latest.turnId,
      consumer: latest.consumer || options.consumer || env.KB_TELEMETRY_CONSUMER || 'mcp-direct',
      featureId: latest.featureId || options.featureId || null,
      hostSessionId: latest.hostSessionId,
    }
  }

  return null
}
