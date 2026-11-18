/**
 * Gateway MCP session：L2 调用追踪（L3 soft warning）
 */
const L2_TOOL_NAMES = new Set([
  'kb_codegraph_search',
  'kb_codegraph_explore',
  'kb_codegraph_node',
  'kb_codegraph_callers',
  'kb_codegraph_callees',
  'kb_codegraph_impact',
  'kb_codegraph_files',
])

const L3_TOOL_NAMES = new Set(['kb_source_read', 'kb_source_grep'])

/** @type {Map<string, { l2At: number, l2Tools: string[] }>} */
const SESSION_STATE = new Map()
const TTL_MS = Number(process.env.KB_MCP_SESSION_L2_TTL_MS || 4 * 60 * 60 * 1000)
const MAX_SESSIONS = Number(process.env.KB_MCP_SESSION_L2_MAX || 512)

function prune() {
  if (SESSION_STATE.size <= MAX_SESSIONS) return
  const now = Date.now()
  for (const [id, st] of SESSION_STATE) {
    if (now - st.l2At > TTL_MS) SESSION_STATE.delete(id)
  }
}

export function markSessionL2(session, toolName) {
  const id = session?.mcpSessionId
  if (!id || !L2_TOOL_NAMES.has(toolName)) return
  const prev = SESSION_STATE.get(id) || { l2At: 0, l2Tools: [] }
  prev.l2At = Date.now()
  if (!prev.l2Tools.includes(toolName)) prev.l2Tools.push(toolName)
  SESSION_STATE.set(id, prev)
  prune()
}

export function sessionHasL2(session) {
  const id = session?.mcpSessionId
  if (!id) return true
  const st = SESSION_STATE.get(id)
  if (!st) return false
  if (Date.now() - st.l2At > TTL_MS) {
    SESSION_STATE.delete(id)
    return false
  }
  return st.l2Tools.length > 0
}

/**
 * @param {string} toolName
 * @param {object} session
 * @returns {object|null}
 */
export function buildL3SoftWarning(toolName, session) {
  if (!L3_TOOL_NAMES.has(toolName)) return null
  if (sessionHasL2(session)) return null
  return {
    code: 'l2_skipped_soft_warning',
    message:
      'This session has not called kb_codegraph_search/explore/callers yet. Prefer L2 to locate symbols before kb_source_read/grep.',
    recommended_tools: [
      { tool: 'kb_codegraph_explore', args: { query: '<symbol>' } },
      { tool: 'kb_codegraph_search', args: { query: '<symbol>' } },
    ],
    note: 'Request was NOT blocked — this is guidance only.',
  }
}

export function attachL3Warning(result, toolName, session) {
  const warning = buildL3SoftWarning(toolName, session)
  if (!warning) return result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, _kb_mcp_warning: warning }
  }
  return { data: result, _kb_mcp_warning: warning }
}

export { L2_TOOL_NAMES, L3_TOOL_NAMES }
