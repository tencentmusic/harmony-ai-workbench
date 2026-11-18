const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OPENCODE_MODEL = 'sub2api/gpt-5.6-luna'
const MODEL_CACHE_TTL_MS = 60_000

export type OpencodeConfig = {
  baseUrl: string
  timeoutMs: number
  username: string
  password: string
}

export class OpencodeConfigError extends Error {
  readonly code:
    | 'opencode_base_url_missing'
    | 'opencode_base_url_not_loopback'
    | 'opencode_integration_base_url_shared'
    | 'opencode_server_username_invalid'
    | 'opencode_server_password_missing'
    | 'opencode_server_password_weak'

  constructor(code: OpencodeConfigError['code']) {
    super(code)
    this.code = code
    this.name = 'OpencodeConfigError'
  }
}

let cachedModel: { value: string; expiresAt: number } | null = null

function readOpencodeConfig(input: {
  baseUrlName: string
  usernameName: string
  passwordName: string
}): OpencodeConfig {
  const baseUrl = process.env[input.baseUrlName]
  if (!baseUrl) {
    throw new OpencodeConfigError('opencode_base_url_missing')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new OpencodeConfigError('opencode_base_url_not_loopback')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new OpencodeConfigError('opencode_base_url_not_loopback')
  }

  const username = process.env[input.usernameName]?.trim() || 'opencode'
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    throw new OpencodeConfigError('opencode_server_username_invalid')
  }
  const password = process.env[input.passwordName] ?? ''
  if (!password) {
    throw new OpencodeConfigError('opencode_server_password_missing')
  }
  if (!/^[0-9a-fA-F]{64}$/.test(password)) {
    throw new OpencodeConfigError('opencode_server_password_weak')
  }

  const timeoutRaw = Number(process.env.OPENCODE_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    timeoutMs,
    username,
    password,
  }
}

export function getOpencodeConfig(): OpencodeConfig {
  return readOpencodeConfig({
    baseUrlName: 'OPENCODE_BASE_URL',
    usernameName: 'OPENCODE_SERVER_USERNAME',
    passwordName: 'OPENCODE_SERVER_PASSWORD',
  })
}

export function getIntegrationOpencodeConfig(): OpencodeConfig {
  const integrationConfig = readOpencodeConfig({
    baseUrlName: 'OPENCODE_INTEGRATION_BASE_URL',
    usernameName: 'OPENCODE_INTEGRATION_SERVER_USERNAME',
    passwordName: 'OPENCODE_INTEGRATION_SERVER_PASSWORD',
  })

  const chatBaseUrl = process.env.OPENCODE_BASE_URL?.trim()
  if (chatBaseUrl) {
    try {
      const chatUrl = new URL(chatBaseUrl)
      const integrationUrl = new URL(integrationConfig.baseUrl)
      if (chatUrl.origin === integrationUrl.origin) {
        throw new OpencodeConfigError('opencode_integration_base_url_shared')
      }
    } catch (error) {
      if (error instanceof OpencodeConfigError) throw error
      // The normal chat config validates its own URL at its consumption boundary.
    }
  }

  return integrationConfig
}

export function buildOpencodeHeaders(
  cfg: OpencodeConfig,
  headers?: HeadersInit,
): Headers {
  const result = new Headers(headers)
  result.set(
    'Authorization',
    `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64')}`,
  )
  return result
}

export async function resolveOpencodeModelLabel(): Promise<string> {
  if (cachedModel && cachedModel.expiresAt > Date.now()) {
    return cachedModel.value
  }

  // 以 OpenCode 进程 /config 为准，避免工台 PM2 未 reload 时 env 仍指向旧 codex/*。
  try {
    const cfg = getOpencodeConfig()
    const res = await fetch(`${cfg.baseUrl}/config`, {
      headers: buildOpencodeHeaders(cfg),
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    if (res.ok) {
      const data = (await res.json()) as { model?: unknown }
      const model =
        typeof data.model === 'string' && data.model.trim() ? data.model.trim() : DEFAULT_OPENCODE_MODEL
      cachedModel = { value: model, expiresAt: Date.now() + MODEL_CACHE_TTL_MS }
      return model
    }
  } catch {
    // fall through
  }

  const fromEnv = process.env.OPENCODE_MODEL?.trim()
  if (fromEnv) return fromEnv

  return DEFAULT_OPENCODE_MODEL
}

export function buildOpencodeModelDisplay(modelLabel: string) {
  const model = modelLabel.trim() || DEFAULT_OPENCODE_MODEL
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    model,
  }
}
