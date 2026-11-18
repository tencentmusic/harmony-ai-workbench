import { resolveOpencodeImageFromPart, type OpencodeFilePartLike } from './opencode-image'

export type OpencodeEvent = {
  id: string
  type: string
  properties?: Record<string, unknown>
}

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; path: string; mime: string; alt?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type TranslatorState = {
  sessionId: string
  partTypes: Record<string, 'text' | 'reasoning' | 'file' | 'other'>
  partMessageIds: Record<string, string>
  messageRoles: Record<string, string>
  emittedText: Record<string, string>
  seenImagePaths: Set<string>
  finished: boolean
}

export function createTranslatorState(sessionId: string): TranslatorState {
  return {
    sessionId,
    partTypes: {},
    partMessageIds: {},
    messageRoles: {},
    emittedText: {},
    seenImagePaths: new Set(),
    finished: false,
  }
}

export function parseSseLine(line: string): OpencodeEvent | null {
  if (!line.startsWith('data: ')) return null
  const json = line.slice(6).trim()
  if (!json || json === '[DONE]') return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown> | null
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = typeof parsed.payload === 'object' && parsed.payload !== null
      ? parsed.payload as Record<string, unknown>
      : parsed
    return typeof candidate.type === 'string' ? candidate as unknown as OpencodeEvent : null
  } catch {
    return null
  }
}

export function translateEvent(
  state: TranslatorState,
  event: OpencodeEvent,
): { state: TranslatorState; emit: ChatStreamEvent[] } {
  if (state.finished) return { state, emit: [] }
  const props = event.properties ?? {}
  const info = props.info as { id?: string; sessionID?: string; role?: string; finish?: string } | undefined
  const part = props.part as (OpencodeFilePartLike & {
    id?: string; sessionID?: string; messageID?: string; type?: string; text?: string
    synthetic?: boolean; ignored?: boolean
  }) | undefined
  const sessionId = props.sessionID ?? info?.sessionID ?? part?.sessionID
  if (sessionId !== state.sessionId) return { state, emit: [] }

  switch (event.type) {
    case 'session.error': {
      const error = props.error as { name?: string; message?: string; data?: { message?: string } } | undefined
      const raw = error?.data?.message?.trim() || error?.message?.trim() || error?.name?.trim() || 'opencode_session_error'
      return {
        state: { ...state, finished: true },
        emit: [{ type: 'error', message: /stream_read_error|upstream_error/i.test(raw)
          ? 'opencode_upstream_stream_interrupted' : raw }],
      }
    }
    case 'message.updated': {
      if (info?.id && info.role) state.messageRoles[info.id] = info.role
      if (info?.role === 'assistant' && info.finish === 'stop') {
        return { state: { ...state, finished: true }, emit: [{ type: 'done' }] }
      }
      return { state, emit: [] }
    }
    case 'message.part.updated': {
      if (!part?.id || !part.type) return { state, emit: [] }
      const type = part.synthetic || part.ignored ? 'other'
        : part.type === 'text' || part.type === 'reasoning' || part.type === 'file' ? part.type : 'other'
      state.partTypes[part.id] = type
      if (part.messageID) state.partMessageIds[part.id] = part.messageID
      if (part.messageID && state.messageRoles[part.messageID] === 'user') return { state, emit: [] }
      if (type === 'file') {
        const image = resolveOpencodeImageFromPart(part)
        if (!image || state.seenImagePaths.has(image.path)) return { state, emit: [] }
        state.seenImagePaths.add(image.path)
        return { state, emit: [{ type: 'image', ...image }] }
      }
      if ((type === 'text' || type === 'reasoning') && typeof part.text === 'string') {
        // Snapshots may repeat previously streamed deltas; forward only the new suffix.
        const previous = state.emittedText[part.id] || ''
        if (!part.text.startsWith(previous)) return { state, emit: [] }
        const suffix = part.text.slice(previous.length)
        state.emittedText[part.id] = part.text
        if (suffix) return { state, emit: [{ type: type === 'text' ? 'token' : 'reasoning', text: suffix }] }
      }
      return { state, emit: [] }
    }
    case 'message.part.delta': {
      const { partID, field, delta } = props
      if (field !== 'text' || typeof partID !== 'string' || typeof delta !== 'string' || !delta) return { state, emit: [] }
      if (state.messageRoles[state.partMessageIds[partID]] === 'user') return { state, emit: [] }
      const type = state.partTypes[partID]
      if (type !== 'text' && type !== 'reasoning') return { state, emit: [] }
      state.emittedText[partID] = (state.emittedText[partID] || '') + delta
      return { state, emit: [{ type: type === 'text' ? 'token' : 'reasoning', text: delta }] }
    }
    case 'session.idle':
      return { state: { ...state, finished: true }, emit: [{ type: 'done' }] }
    default:
      return { state, emit: [] }
  }
}
