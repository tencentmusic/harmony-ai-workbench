import {
  type OpencodeConfig,
  buildOpencodeHeaders,
  getOpencodeConfig,
  resolveOpencodeModelLabel,
} from './opencode-config'

const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{1,128}$/
const SAFE_SESSION_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidOpencodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && OPENCODE_SESSION_ID_PATTERN.test(value)
}

export function isSafeOpencodeSessionPathSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SESSION_PATH_SEGMENT_PATTERN.test(value)
}

export type OpencodeSessionModel = {
  id?: string
  providerID?: string
}

export function parseOpencodeModelLabel(label: string): { providerID: string; modelID: string } | null {
  const trimmed = label.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return null
  const providerID = trimmed.slice(0, slash).trim()
  const modelID = trimmed.slice(slash + 1).trim()
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export function isCodexOpencodeModel(modelLabel: string): boolean {
  return parseOpencodeModelLabel(modelLabel)?.providerID === 'codex'
}

/** OpenCode session 尚未绑定 model 时会在首次 prompt 使用 global config，可继续复用。 */
export function opencodeSessionMatchesModel(
  sessionModel: OpencodeSessionModel | null | undefined,
  expectedLabel: string,
): boolean {
  if (!sessionModel?.providerID || !sessionModel?.id) return true
  const expected = parseOpencodeModelLabel(expectedLabel)
  if (!expected) return true
  return sessionModel.providerID === expected.providerID && sessionModel.id === expected.modelID
}

/**
 * 续聊前校验 OpenCode session 绑定的模型是否与当前工台配置一致。
 * 不一致（例如旧 session 仍绑定 deepseek/*）则丢弃 sessionId，强制新建 session 以使用新模型。
 */
export async function reconcileOpencodeSessionId(
  sessionId: string | null | undefined,
  cfg?: OpencodeConfig,
): Promise<string | null> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return null

  const expectedModel = await resolveOpencodeModelLabel()

  let config: OpencodeConfig
  try {
    config = cfg ?? getOpencodeConfig()
  } catch {
    return null
  }

  try {
    const res = await fetch(`${config.baseUrl}/session/${encodeURIComponent(id)}`, {
      headers: buildOpencodeHeaders(config),
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as { model?: OpencodeSessionModel | null }
    return opencodeSessionMatchesModel(data.model, expectedModel) ? id : null
  } catch {
    return null
  }
}
