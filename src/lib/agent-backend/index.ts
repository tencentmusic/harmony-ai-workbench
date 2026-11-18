import { resolveOpencodeModelLabel } from '@/lib/opencode/opencode-config'

import { streamChatOpencodeBackend } from './opencode-backend'
import type { ChatStreamEvent, StreamChatInput } from './types'

export type { ChatStreamEvent, StreamChatInput }
export { parseAgentSessionId, resolveAgentBackend, agentBackendLabel, getAgentWorkspaceCwd } from './resolve-backend'

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
  yield* streamChatOpencodeBackend(input)
}

export async function resolveAgentModelLabel(): Promise<string> {
  return resolveOpencodeModelLabel()
}

export function buildAgentModelDisplay(modelLabel: string) {
  const model = modelLabel.trim() || 'github-copilot/gpt-5.4-mini'
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    model,
  }
}
