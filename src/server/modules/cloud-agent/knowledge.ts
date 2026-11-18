import { createHash } from 'node:crypto'
import { listKnowledgeSources, resolveKnowledgeFeatureContext, readKnowledge } from 'android-harmony-kb/knowledge-runtime'
import { listKnowledgeCatalog, searchKnowledgeDocuments, readKnowledgeDocument } from '@/server/modules/knowledge/public'
import { CloudError, record } from './domain'
import { taskTool, textResult } from './task-tools'
import type { CloudProject } from './config'

export function knowledgeTools(project: CloudProject) {
  const sources = () => {
    const catalog = record(listKnowledgeSources({ project_id: project.kbProjectId }))
    return Array.isArray(catalog.sources) ? catalog.sources.map(record) : []
  }
  const source = (id: unknown) => {
    if (typeof id !== 'string' || !sources().some(row => row.source_id === id)) throw new CloudError('知识源不属于当前 App', 403)
    return id
  }
  const string = { type: 'string' }
  return [
    taskTool('knowledge_catalog', '分页发现当前 App 的技术知识源和迁移案例库，只返回目录，不展开正文', { offset: { type: 'integer', minimum: 0 } }, [], async args => {
      const offset = Number(args.offset || 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CloudError('目录偏移非法')
      const items = [...sources().map(row => ({ kind: 'technical', ...row })), ...listKnowledgeCatalog([project.id], { group: 'migration', counts: false }).map(row => ({ kind: 'migration', libraryId: row.libraryId, label: row.sourceLabel }))]
      return textResult({ items: items.slice(offset, offset + 20), nextOffset: offset + 20 < items.length ? offset + 20 : null })
    }),
    taskTool('knowledge_query', '在已发现的技术知识源内按功能定向检索，返回业务逻辑、代码映射及引用；不是源码事实', { sourceId: string, query: string }, ['sourceId', 'query'], async args => {
      if (typeof args.query !== 'string' || args.query.trim().length < 2 || args.query.length > 300) throw new CloudError('查询应为 2-300 字')
      return textResult(resolveKnowledgeFeatureContext({ project_id: project.kbProjectId, source_id: source(args.sourceId), query: args.query, max_content_chars: 12000 }))
    }),
    taskTool('knowledge_read', '按查询返回的 doc_ref 读取单篇技术知识，不允许任意文件路径', { sourceId: string, docRef: string }, ['sourceId', 'docRef'], async args => {
      if (typeof args.docRef !== 'string' || args.docRef.length > 1000) throw new CloudError('知识引用非法')
      return textResult(readKnowledge({ project_id: project.kbProjectId, source_id: source(args.sourceId), doc_ref: args.docRef, max_content_chars: 16000 }))
    }),
    taskTool('migration_query', '在目录返回的迁移案例库查询或读取单篇案例，只作经验参考，不能覆盖当前 App 源码事实', { libraryId: string, query: string, path: string }, ['libraryId'], async args => {
      const library = listKnowledgeCatalog([project.id], { group: 'migration', counts: false }).find(row => row.libraryId === args.libraryId)
      if (!library) throw new CloudError('迁移案例库不可用', 403)
      if (typeof args.path === 'string' && args.path.length <= 1000) {
        const doc = readKnowledgeDocument({ libraryId: library.libraryId, path: args.path, allowedScopeIds: [project.id] })
        return textResult({ path: doc.path, markdown: doc.markdown.slice(0, 16000), truncated: doc.markdown.length > 16000 })
      }
      if (typeof args.query !== 'string' || args.query.length < 2 || args.query.length > 300) throw new CloudError('查询应为 2-300 字')
      return textResult(searchKnowledgeDocuments({ libraryId: library.libraryId, query: args.query, allowedScopeIds: [project.id] }).slice(0, 20))
    }),
  ]
}

export function collectKnowledge(project: CloudProject, title: string, material: string) {
  const evidence: string[] = []
  const warnings: string[] = []
  const hints = [...new Set(material.match(/\b[A-Z][A-Za-z0-9_]{5,}\b/g) || [])].slice(0, 8)
  try {
    const catalog = record(listKnowledgeSources({ project_id: project.kbProjectId }))
    const sources = Array.isArray(catalog.sources) ? catalog.sources.map(record).slice(0, 4) : []
    for (const source of sources) {
      try {
        const context = record(resolveKnowledgeFeatureContext({ project_id: project.kbProjectId, source_id: source.source_id, query: title, hints, max_content_chars: 6000 }))
        if (context.hit) evidence.push(`业务知识索引命中（文档证据，不代表当前源码）：\n${JSON.stringify(context)}`)
      } catch { warnings.push(`业务知识源 ${source.source_id} 不可读取，未扩大到整库扫描`) }
    }
  } catch { warnings.push('业务知识索引不可用，需按源码和材料核验') }
  for (const library of listKnowledgeCatalog([project.id], { group: 'migration', counts: false }).slice(0, 4)) {
    try {
      const hits = searchKnowledgeDocuments({ libraryId: library.libraryId, query: title, allowedScopeIds: [project.id] })
      // Untagged or other-App examples cannot establish this App's business facts.
      for (const hit of hits.filter(hit => hit.appScopeId === project.id).slice(0, 2)) {
        const doc = readKnowledgeDocument({ libraryId: library.libraryId, path: hit.path, allowedScopeIds: [project.id] })
        const hash = createHash('sha256').update(doc.markdown).digest('hex')
        evidence.push(`迁移案例 ${doc.sourceLabel}/${doc.path}（仅供参考；摘要 ${hash}）：\n${doc.markdown.slice(0, 4000)}`)
      }
    } catch { warnings.push(`迁移案例源 ${library.sourceLabel} 不可读取`) }
  }
  return { evidence, warnings }
}
