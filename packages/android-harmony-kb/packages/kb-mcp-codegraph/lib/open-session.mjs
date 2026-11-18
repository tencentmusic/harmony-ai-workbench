import crypto from 'crypto'

const SESSIONS = new Map()
const TTL_MS = Number(process.env.KB_MCP_SESSION_TTL_MS || 4 * 60 * 60 * 1000)

/** 无鉴权开放 session：双 project，不做 module scope 限制 */
export function buildOpenSession() {
  return {
    tokenId: null,
    personCode: null,
    personName: 'anonymous',
    appScopeIds: [],
    allowedKbProjectIds: ['kugou-music', 'kugou-live'],
    prefixEntries: [],
  }
}

export function assertKbProject(session, projectId) {
  const pid = String(projectId || 'kugou-music').trim()
  if (!session.allowedKbProjectIds.includes(pid)) {
    throw new Error(`project_id_not_allowed:${pid}`)
  }
  return pid
}

export function assertPlatform(platform) {
  const p = String(platform || 'android').trim().toLowerCase()
  if (p !== 'android' && p !== 'harmonyos') throw new Error(`invalid_platform:${p}`)
  return p
}

function sessionKey(clientKey) {
  return crypto.createHash('sha256').update(String(clientKey || '')).digest('hex').slice(0, 24)
}

/** 按 client IP + UA 聚合 telemetry session */
export function getOrCreateOpenMcpSession(clientKey) {
  const key = sessionKey(clientKey)
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
