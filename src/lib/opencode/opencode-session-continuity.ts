import type { ChatMessage } from '@/lib/chat-store'
import { isValidOpencodeSessionId } from '@/lib/opencode/opencode-session'

export type OpencodeChatContinuity = 'fresh' | 'opencode_session' | 'workbench_rehydrate'

const TRANSCRIPT_ASSISTANT_MAX = 2400
const TRANSCRIPT_USER_MAX = 600

export function countAssistantTurns(messages: ChatMessage[] | null | undefined) {
  return (messages || []).filter((m) => m.role === 'assistant').length
}

export function resolveOpencodeChatContinuity(opts: {
  priorMessages: ChatMessage[] | null | undefined
  opencodeSessionId: string | null | undefined
}): OpencodeChatContinuity {
  const assistantTurns = countAssistantTurns(opts.priorMessages)
  if (assistantTurns <= 0) return 'fresh'
  if (isValidOpencodeSessionId(opts.opencodeSessionId)) return 'opencode_session'
  return 'workbench_rehydrate'
}

export function buildOpencodeSessionContinueText(userMessage: string) {
  const question = String(userMessage || '').trim()
  return `[工台 · OpenCode session 续聊]
同一会话 OpenCode session 已保留完整上文。请直接承接上一轮已确定的 FQN、文件路径、模块与结论作答。
禁止因当前句未重述类名而重新发起全仓 L2/glob/grep 或更换分析目标。

用户问题：${question}`
}

export function buildWorkbenchRehydrateText(priorMessages: ChatMessage[], userMessage: string) {
  const question = String(userMessage || '').trim()
  const lines = [
    '[工台 · 工台 chat session 续聊]',
    'OpenCode session 不可用，以下为同工台会话已保存的上文，须据此继续作答，禁止当作全新问题重新 broad search。',
    '',
  ]

  for (const msg of priorMessages.slice(-8)) {
    if (msg.role === 'user' && msg.content.trim() === question) continue
    const label = msg.role === 'user' ? '用户' : '助手'
    const limit = msg.role === 'assistant' ? TRANSCRIPT_ASSISTANT_MAX : TRANSCRIPT_USER_MAX
    const body = msg.content.trim().slice(0, limit)
    if (!body) continue
    lines.push(`${label}：${body}`, '')
  }

  lines.push(`用户问题：${question}`)
  return lines.join('\n')
}

export function buildContinuedOpencodePrompt(opts: {
  continuity: OpencodeChatContinuity
  userMessage: string
  priorMessages?: ChatMessage[]
}) {
  const question = String(opts.userMessage || '').trim()
  if (opts.continuity === 'opencode_session') {
    return buildOpencodeSessionContinueText(question)
  }
  if (opts.continuity === 'workbench_rehydrate') {
    return buildWorkbenchRehydrateText(opts.priorMessages || [], question)
  }
  return question
}
