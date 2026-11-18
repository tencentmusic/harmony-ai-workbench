const INTROSPECT_CACHE = new Map()
const CACHE_TTL_MS = 60_000

export function workbenchBaseUrl(env = process.env) {
  return String(env.WORKBENCH_URL || env.WORKBENCH_PUBLIC_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '')
}

export async function fetchIntrospect(bearer, env = process.env) {
  const raw = String(bearer || '').trim()
  if (!raw) throw new Error('missing_bearer_token')

  const cacheKey = raw.slice(0, 12)
  const hit = INTROSPECT_CACHE.get(cacheKey)
  if (hit && hit.expiresAt > Date.now() && hit.bearer === raw) return hit.value

  const url = `${workbenchBaseUrl(env)}/api/kb-mcp/v1/introspect`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${raw}` },
    signal: AbortSignal.timeout(Number(env.KB_MCP_INTROSPECT_TIMEOUT_MS || 15000)),
  })
  if (res.status === 401) throw new Error('unauthorized')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`introspect_${res.status}:${text.slice(0, 200)}`)
  }
  const value = await res.json()
  INTROSPECT_CACHE.set(cacheKey, { bearer: raw, expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}

/** 解析 Authorization 头；标准写法为 `Bearer hm_xxx` */
export function extractBearer(header) {
  const h = String(header || '').trim()
  if (!h) return null
  if (h.toLowerCase().startsWith('bearer ')) {
    const raw = h.slice(7).trim()
    return raw || null
  }
  return h
}

function normalizeRawToken(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  if (value.toLowerCase().startsWith('bearer ')) {
    const stripped = value.slice(7).trim()
    return stripped || null
  }
  return value
}

/**
 * 从请求提取 hm_ token。
 * 优先 Authorization: Bearer hm_xxx（Cursor/HTTP 客户端普遍要求 Bearer 前缀）；
 * 备选 X-KB-MCP-Token（部分客户端会丢弃非标准 Authorization scheme）。
 */
export function extractTokenFromRequest(req) {
  const fromAuth = extractBearer(req?.headers?.authorization)
  if (fromAuth) return fromAuth
  const alt =
    req?.headers?.['x-kb-mcp-token'] ||
    req?.headers?.['x-api-token'] ||
    ''
  return normalizeRawToken(alt)
}
