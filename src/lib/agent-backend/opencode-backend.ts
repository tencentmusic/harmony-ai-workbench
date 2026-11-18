import { getOpencodeConfig } from '@/lib/opencode/opencode-config'
import { streamChat as streamChatOpencode } from '@/lib/opencode/opencode-client'

import type { StreamChatInput } from './types'

export async function* streamChatOpencodeBackend(input: StreamChatInput) {
  yield* streamChatOpencode({
    message: input.message,
    attachments: input.attachments,
    sessionId: input.sessionId,
    shouldCancel: input.shouldCancel,
    signal: input.signal,
    cfg: getOpencodeConfig(),
  })
}
