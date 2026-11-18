import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeTools } from './knowledge'
import { cloudProject } from './config'

test('knowledge tools paginate catalogs and reject arbitrary sources and document paths', async () => {
  const tools = knowledgeTools(cloudProject('KugouLive'))
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.definition.name === name)!.call(args)
  const response = await call('knowledge_catalog', {})
  const content = response.content[0]
  assert.equal(content.type, 'text')
  const catalog = JSON.parse(content.type === 'text' ? content.text : '')
  assert.ok(Array.isArray(catalog.items) && catalog.items.length <= 20)
  await assert.rejects(call('knowledge_catalog', { offset: -1 }), /偏移/)
  await assert.rejects(call('knowledge_query', { sourceId: 'unknown-source-fixture', query: 'profile' }), /当前 App/)
  await assert.rejects(call('knowledge_read', { sourceId: 'unknown-source-fixture', docRef: '../../.env' }), /当前 App/)
  await assert.rejects(call('migration_query', { libraryId: 'unknown-library-fixture', path: '../../.env' }), /不可用/)
})
