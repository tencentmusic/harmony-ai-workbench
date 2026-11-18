import { CloudError } from './domain'
import { ReadCoverage } from './code-review-domain'
import { taskTool, textResult, type TaskTool } from './task-tools'

export function reviewReadBatch(tools: TaskTool[], coverage: ReadCoverage, required: string[], images: string[], signal: AbortSignal) {
  return taskTool('review_read_batch', '批量补读已登记的审查上下文，自动选路径和续读offset；每次最多2页，返回pendingReads；图片使用review_image。无需参数，不替代review_diff及最终审查。', {}, [], async args => {
    if (Object.keys(args).length) throw new CloudError('批量审查读取不接受路径或其他参数')
    signal.throwIfAborted()
    const pages: { key: string; offset: number; content: unknown; isError: boolean }[] = []
    const blocked = new Set<string>()
    // Delegate to the same scoped, hash-tracked readers as individual requests.
    for (let i = 0; i < 2; i++) {
      signal.throwIfAborted()
      const next = coverage.pending(required).find(item => item.key !== 'diff' && !blocked.has(item.key) && !images.some(file => item.key === `harmony:${file}`))
      if (!next) break
      const { key, offset } = next, colon = key.indexOf(':')
      const kind = key.slice(0, colon), file = key.slice(colon + 1)
      const archive = kind === 'archive' ? JSON.parse(file) as [string, string] : null
      const name = archive ? 'source_archive' : kind === 'rule' ? 'harness_rule' : kind === 'artifact' ? 'artifact_read' : ['android', 'harmony'].includes(kind) ? 'source_read' : ''
      const tool = tools.find(tool => tool.definition.name === name)
      if (!tool) { blocked.add(key); continue }
      try {
        const result = await tool.call({ path: archive ? archive[0] : file, ...(archive ? { entry: archive[1] } : {}), offset, ...(['android', 'harmony'].includes(kind) ? { platform: kind } : {}) })
        pages.push({ key, offset, content: result.content.map(item => item.type === 'text' ? JSON.parse(item.text) : item), isError: !!result.isError })
      } catch (error) {
        signal.throwIfAborted()
        pages.push({ key, offset, content: error instanceof Error ? error.message : '读取失败', isError: true })
      }
      if (coverage.pending([key]).some(item => item.offset === offset)) blocked.add(key)
    }
    return textResult({ pages, pendingReads: coverage.pending(required) })
  })
}
