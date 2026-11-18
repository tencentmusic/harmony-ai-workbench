import crypto from 'crypto'

const SESSIONS = new Map()
const TTL_MS = Number(process.env.KB_MCP_SESSION_TTL_MS || 4 * 60 * 60 * 1000)

function sessionKey(bearer) {
  return crypto.createHash('sha256').update(String(bearer || '')).digest('hex').slice(0, 24)
}

/** 同一 Bearer 在 TTL 内共享 mcp_session_id，便于审计聚合 */
export function getOrCreateMcpSession(bearer) {
  const key = sessionKey(bearer)
  const now = Date.now()
  const hit = SESSIONS.get(key)
  if (hit && now - hit.at < TTL_MS) {
    hit.at = now
    return hit.id
  }
  const id = crypto.randomUUID()
  SESSIONS.set(key, { id, at: now })
  return id
}
