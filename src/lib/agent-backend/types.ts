export type AgentBackend = 'opencode'

export type { ChatStreamEvent } from '../opencode/opencode-events'

export type StreamChatInput = {
  message: string
  attachments?: Array<{
    path: string
    name: string
    mime: string
    size: number
    dataUrl?: string
  }>
  sessionId?: string | null
  chatSessionId?: string | null
  signal?: AbortSignal
  shouldCancel?: () => boolean
}
