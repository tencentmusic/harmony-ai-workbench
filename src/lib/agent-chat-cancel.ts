/** 每个 chatSession 的 run 代际；新消息或取消会 bump，旧后台流自动失效。 */
const runGenerationByChatSession = new Map<string, number>()

/** 开始新 run（会先 bump，使同 session 旧 run 失效）。 */
export function beginChatAgentRun(chatSessionId: string): number {
  const next = (runGenerationByChatSession.get(chatSessionId) ?? 0) + 1
  runGenerationByChatSession.set(chatSessionId, next)
  return next
}

/** 用户取消：bump 代际 + 返回新代际号。 */
export function cancelChatAgentRun(chatSessionId: string): number {
  return beginChatAgentRun(chatSessionId)
}

export function isChatAgentRunCurrent(
  chatSessionId: string | null | undefined,
  generation: number,
): boolean {
  if (!chatSessionId) return true
  return (runGenerationByChatSession.get(chatSessionId) ?? 0) === generation
}

export function shouldAbortChatAgentRun(
  chatSessionId: string | null | undefined,
  generation: number,
): boolean {
  return !isChatAgentRunCurrent(chatSessionId, generation)
}
