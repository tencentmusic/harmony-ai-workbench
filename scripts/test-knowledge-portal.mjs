#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  getKnowledgeTree,
  KnowledgeAccessError,
  listKnowledgeCatalog,
  readKnowledgeAsset,
  readKnowledgeDocument,
  resolveKnowledgeLocatorFromMessage,
  searchKnowledgeDocuments,
} from '../src/server/modules/knowledge/public.ts'

const catalog = listKnowledgeCatalog(['KugouPlayer'])
const technicalLibraries = catalog.filter((item) => item.group === 'technical')
const migrationLibraries = catalog.filter((item) => item.group === 'migration')

assert.deepEqual(technicalLibraries.map((item) => item.label), ['酷狗直播'])
assert.deepEqual(technicalLibraries.map((item) => item.libraryId), ['technical:fxwiki'])
assert.deepEqual(migrationLibraries.map((item) => item.label), ['鸿蒙迁移案例'])
assert.deepEqual(migrationLibraries.map((item) => item.libraryId), ['migration:migration-cases'])
assert.ok(migrationLibraries.every((item) => !item.appScopeId), '共享迁移案例不应成为 App 权限边界')

const technicalTree = getKnowledgeTree({
  libraryId: 'technical:fxwiki',
  allowedScopeIds: ['KugouPlayer'],
})
assert.ok(technicalTree.length > 0)
assert.ok(!technicalTree.some((node) => node.title === 'wiki'), '目录不应暴露 wiki/features 包装层')

const technicalPaths = []
const collectPaths = (nodes) => {
  for (const node of nodes) {
    if (node.path) technicalPaths.push(node.path)
    collectPaths(node.children || [])
  }
}
collectPaths(technicalTree)

const featureRoot = path.resolve('../fxwiki/android_wiki/wiki/features')
const markdownCount = (root) => fs.readdirSync(root, { withFileTypes: true }).reduce(
  (count, entry) => count + (entry.isDirectory()
    ? markdownCount(path.join(root, entry.name))
    : /\.md$/i.test(entry.name) ? 1 : 0),
  0,
)
assert.equal(technicalPaths.length, markdownCount(featureRoot), '技术知识目录应完整覆盖 features')
assert.ok(technicalPaths.every((item) => item.startsWith('wiki/features/')))
assert.ok(technicalPaths.some((item) => /implementation\.md$/i.test(item)), '技术知识目录应展示业务实现')
assert.ok(technicalPaths.some((item) => /code_map\//i.test(item)), '技术知识目录应展示 CodeMap')

const technicalDocumentWithAllScopes = readKnowledgeDocument({
  libraryId: 'technical:fxwiki',
  path: 'wiki/features/我的/个人资料/implementation.md',
  allowedScopeIds: [],
})
assert.equal(
  technicalDocumentWithAllScopes.appScopeId,
  'KugouLive',
  '技术知识目录映射只用于问 AI 推导源码范围',
)
assert.equal(
  readKnowledgeDocument({
    libraryId: 'technical:fxwiki',
    path: 'wiki/features/我的/个人资料/implementation.md',
    allowedScopeIds: ['KugouPlayer'],
  }).appScopeId,
  undefined,
  '技术知识对登录用户可见，但不能扩展其源码权限',
)

const recoveredLocator = resolveKnowledgeLocatorFromMessage({
  message: '请结合 wiki/features/我的/个人资料/implementation.md 分析当前源码',
  allowedScopeIds: [],
})
assert.equal(recoveredLocator?.libraryId, 'technical:fxwiki')
assert.equal(recoveredLocator?.appScopeId, 'KugouLive')

const linkedImplementation = 'wiki/features/工程规范与基础能力/代码评审与编码规范/implementation.md'
assert.ok(technicalPaths.includes(linkedImplementation), '业务实现必须进入完整目录')
assert.match(readKnowledgeDocument({
  libraryId: 'technical:fxwiki',
  path: linkedImplementation,
  allowedScopeIds: ['KugouPlayer'],
}).markdown, /核心流程/)

assert.ok(readKnowledgeDocument({
  libraryId: 'technical:fxwiki',
  path: 'wiki/sources/articles/Android充值联调方法.md',
  allowedScopeIds: ['KugouPlayer'],
}).markdown.length > 0, 'features 引用的来源文档应可打开，但不进入目录树')

const codeMapPath = technicalPaths.find((item) => /code_map\//i.test(item))
assert.ok(codeMapPath)
assert.ok(readKnowledgeDocument({
  libraryId: 'technical:fxwiki',
  path: codeMapPath,
  allowedScopeIds: ['KugouLive'],
}).markdown.length > 0)

const tree = getKnowledgeTree({
  libraryId: 'migration:migration-cases',
  allowedScopeIds: ['KugouPlayer'],
})
assert.ok(tree.length > 0)
assert.equal(tree[0]?.path, 'migration/README.md', '迁移案例目录索引应固定在目录树首项')
assert.equal(tree[0]?.title, 'Harmony 迁移文档')

const overview = readKnowledgeDocument({
  libraryId: 'migration:migration-cases',
  path: 'migration/README.md',
  allowedScopeIds: ['KugouPlayer'],
})
assert.equal(overview.role, 'evidence')
assert.match(overview.markdown, /酷狗音乐/)
assert.match(overview.markdown, /目录结构/)

const liveDocument = readKnowledgeDocument({
  libraryId: 'migration:migration-cases',
  path: 'migration/酷狗直播/README.md',
  allowedScopeIds: ['KugouPlayer'],
})
assert.equal(liveDocument.appScopeId, undefined, '无直播源码权限时仍可读案例，但不得扩展源码范围')

const liveDocumentWithAllScopes = readKnowledgeDocument({
  libraryId: 'migration:migration-cases',
  path: 'migration/酷狗直播/README.md',
  allowedScopeIds: [],
})
assert.equal(liveDocumentWithAllScopes.appScopeId, 'KugouLive', '目录映射应为问 AI 推导源码范围')

const asset = readKnowledgeAsset({
  libraryId: 'migration:migration-cases',
  path: 'migration/酷狗音乐/ktv模块/伴奏准备/drawable/drawable-xhdpi/douge_back_icon.webp',
  allowedScopeIds: ['KugouPlayer'],
})
assert.equal(asset.contentType, 'image/webp')
assert.ok(asset.bytes.length > 0)

const hits = searchKnowledgeDocuments({
  libraryId: 'migration:migration-cases',
  query: '歌手歌曲列表',
  allowedScopeIds: ['KugouPlayer'],
})
assert.ok(hits.some((hit) => hit.path.includes('歌手歌曲列表')))
assert.ok(hits.every((hit) => hit.libraryId === 'migration:migration-cases'))
assert.ok(hits.some((hit) => hit.summary.includes('歌手歌曲列表')), '搜索摘要应包含命中上下文')

assert.throws(
  () => readKnowledgeDocument({
    libraryId: 'migration:migration-cases',
    path: '../ktv-harmony-docs/README.md',
    allowedScopeIds: ['KugouPlayer'],
  }),
  (error) => error instanceof KnowledgeAccessError && error.status === 400,
)

console.log('test:knowledge-portal OK')
