import { sanitizeSessionTitleBody } from '@/lib/session-title'

import { streamChat } from './index'

const TITLE_TIMEOUT_MS = 25_000

const TITLE_TASK_PREFIX =
  '【仅生成会话标题】根据用户首条消息，输出一个 4-18 字的中文标题，概括用户意图。' +
  '只输出标题文本：不要引号、不要解释、不要 markdown、不要分析代码、不要多余标点。'

export async function generateSessionTitleByAgent(userPrompt: string) {
  const message = `${TITLE_TASK_PREFIX}\n\n用户消息：${String(userPrompt || '').slice(0, 600)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)

  let content = ''
  try {
    for await (const event of streamChat({ message, sessionId: null, signal: controller.signal })) {
      if (event.type === 'token') {
        content += event.text
      } else if (event.type === 'error') {
        throw new Error(event.message)
      } else if (event.type === 'done') {
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const title = sanitizeSessionTitleBody(content)
  if (!title) throw new Error('agent_title_empty')
  return title
}
