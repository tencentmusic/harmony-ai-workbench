import { record } from './domain'
import type { TaskTool } from './task-tools'

export const REVIEW_PAGE_SIZE = 6000

// Bound the delivered page before recording coverage; the transport may truncate larger replies.
export function boundedReviewPage(result: Awaited<ReturnType<TaskTool['call']>>, offset: number) {
  return { ...result, content: result.content.map(item => {
    if (item.type !== 'text') return item
    const value = record(JSON.parse(item.text))
    if (typeof value.text !== 'string' || value.text.length <= REVIEW_PAGE_SIZE) return item
    return { ...item, text: JSON.stringify({ ...value, text: value.text.slice(0, REVIEW_PAGE_SIZE), nextOffset: offset + REVIEW_PAGE_SIZE }) }
  }) }
}
