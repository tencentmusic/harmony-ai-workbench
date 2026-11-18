#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-opencode-fxwiki-'))
const fxwikiRoot = path.join(fixtureRoot, 'fxwiki')
const contentRoot = path.join(fxwikiRoot, 'android_wiki')

function write(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

try {
  write('fxwiki/android_wiki/wiki/indexes/manifest/catalog.json', JSON.stringify({
    schema_version: 1,
    validation: { status: 'passed' },
    features: [{
      feature_id: 'account_settings',
      title: '账号设置',
      aliases: ['设置与帮助'],
      summary: '管理悬浮窗和后台播放。',
      breadcrumb: ['账号', '设置'],
      applies_to: ['kugou_live.android', 'kugou_live.harmony'],
      canonical_readme: 'wiki/features/账号/设置/README.md',
      route_shard: '账号',
      confidence: 'high',
    }],
  }))
  write('fxwiki/android_wiki/wiki/indexes/manifest/symbols.jsonl', `${[
    {
      feature_id: 'account_settings',
      symbol: 'com.example.SettingsActivity',
      class_fqn: 'com.example.SettingsActivity',
      simple_name: 'SettingsActivity',
      targets: ['kugou_live.android'],
      read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
    },
    {
      feature_id: 'account_settings',
      symbol: 'com.example.SettingsActivity#onCreate(Bundle)',
      class_fqn: 'com.example.SettingsActivity',
      simple_name: 'SettingsActivity',
      targets: ['kugou_live.android'],
      read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
    },
    {
      feature_id: 'account_settings',
      symbol: 'com.example.SettingsPage',
      class_fqn: 'com.example.SettingsPage',
      simple_name: 'SettingsPage',
      targets: ['kugou_live.harmony'],
      read: ['wiki/features/账号/设置/code_map/live_harmony#主链路 FQN'],
    },
    {
      feature_id: 'account_settings',
      symbol: 'com.example.shared.widget',
      class_fqn: 'com.example.shared.widget',
      simple_name: 'widget',
      targets: ['kugou_live.android'],
      read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
    },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`)
  write('fxwiki/android_wiki/wiki/indexes/manifest/routes/账号.json', JSON.stringify({
    routes: [
      {
        feature_id: 'account_settings',
        intent: 'overview',
        phrases: [{ phrase: '设置实现' }],
        read: ['wiki/features/账号/设置/implementation.md'],
        targets: ['kugou_live.android', 'kugou_live.harmony'],
        source_chain: ['wiki/features/账号/设置/README.md'],
      },
      {
        feature_id: 'account_settings',
        intent: 'code_entry',
        phrases: [{ phrase: '设置入口' }],
        read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
        targets: ['kugou_live.android'],
        source_chain: ['wiki/features/账号/设置/README.md'],
      },
      {
        feature_id: 'account_settings',
        intent: 'code_entry',
        phrases: [{ phrase: '鸿蒙设置入口' }],
        read: ['wiki/features/账号/设置/code_map/live_harmony#主链路 FQN'],
        targets: ['kugou_live.harmony'],
        source_chain: ['wiki/features/账号/设置/README.md'],
      },
    ],
  }))
  write('fxwiki/android_wiki/wiki/features/账号/设置/README.md', '# 账号设置\n\n## 模块定位\n\n管理设置入口。\n\n## 无关长篇\n\n不应在精确代码地图查询中注入。\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/implementation.md', '# 设置实现\n\n管理账号设置业务流程。\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/code_map/live_android.md', '# Android 代码地图\n\n## 主链路 FQN\n\n`com.example.SettingsActivity`\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/code_map/live_harmony.md', '# Harmony 代码地图\n\n## 主链路 FQN\n\n`com.example.SettingsPage`\n')

  const configPath = path.join(fixtureRoot, 'workspace-apps.json')
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: '2.0',
    runtime: { default_profile: 'test' },
    shared_knowledge_bases: [{
      id: 'fxwiki',
      label: 'fxwiki fixture',
      provider: 'fxwiki',
      enabled: true,
      workspace_alias: 'fxwiki',
      connections: { test: { path: fxwikiRoot } },
      query: {
        adapter: 'feature-manifest-v1',
        content_root: 'android_wiki',
        project_targets: { 'kugou-live': ['kugou_live.android', 'kugou_live.harmony'] },
      },
      capabilities: ['document-search', 'mcp-query'],
    }],
    projects: [{
      project_id: 'kugou-live',
      label: '直播',
      sources: { android: { source_id: 'live', locations: { test: { path: fixtureRoot } } } },
      apps: [{ app_id: 'KugouLive', scope: { android: { mode: 'whole-repository' } } }],
      knowledge: [{ use: 'fxwiki' }],
    }],
  }), 'utf8')
  process.env.WORKSPACE_APPS_CONFIG = configPath
  process.env.WORKSPACE_PROFILE = 'test'

  const {
    buildOpencodeKnowledgeBundle,
    buildOpencodeKnowledgeDirective,
  } = await import('../src/lib/opencode/opencode-knowledge-context.ts')

  const first = await buildOpencodeKnowledgeBundle(
    '账号设置的 Android 和 Harmony 入口是什么？',
    [],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.equal(first.meta.hit, true, JSON.stringify(first, null, 2))
  assert.equal(first.meta.retrieval_mode, 'kb_pack')
  assert.equal(first.meta.feature_id, 'account_settings')
  assert.match(first.directive, /L1 业务知识/)
  assert.match(first.directive, /SettingsActivity/)
  assert.match(first.directive, /SettingsPage/)
  assert.doesNotMatch(first.directive, /harmony-kb\/mappings|legacy_fallback/)

  const second = await buildOpencodeKnowledgeBundle(
    'SettingsActivity 的源码分析',
    [{ fqn: 'com.example.SettingsActivity' }],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.equal(second.meta.hit, true)
  assert.equal(second.meta.feature_id, 'account_settings')
  assert.equal(second.meta.match_by, 'knowledge:symbol')

  const exactRoute = await buildOpencodeKnowledgeBundle(
    '请结合业务知识库文档《设置代码地图》（wiki/features/账号/设置/code_map/live_android.md）分析 com.example.SettingsActivity#onCreate(Bundle)',
    [],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.equal(exactRoute.meta.hit, true, JSON.stringify(exactRoute, null, 2))
  assert.equal(exactRoute.meta.feature_id, 'account_settings')
  assert.match(exactRoute.directive, /manifest_exact_route/)
  assert.match(exactRoute.directive, /code_map\/live_android\.md#主链路 FQN/)
  assert.match(exactRoute.directive, /SettingsActivity/)
  assert.match(exactRoute.directive, /禁止重复调用 kb_knowledge_search \/ kb_knowledge_read/)
  assert.doesNotMatch(exactRoute.directive, /不应在精确代码地图查询中注入/)
  assert.ok((exactRoute.meta.inject_chars || 0) < 6000)

  const selectedDocument = await buildOpencodeKnowledgeBundle(
    '请结合业务知识库文档《设置实现》（wiki/features/账号/设置/implementation.md）分析，并说明当前源码是否仍一致。',
    [],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.equal(selectedDocument.meta.match_by, 'knowledge:doc_ref')
  assert.equal(selectedDocument.meta.cross_platform_ready, true)
  assert.deepEqual(selectedDocument.meta.read_refs, [
    'wiki/features/账号/设置/implementation.md',
    'wiki/features/账号/设置/code_map/live_android.md#主链路 FQN',
    'wiki/features/账号/设置/code_map/live_harmony.md#主链路 FQN',
  ])
  assert.match(selectedDocument.directive, /管理账号设置业务流程/)
  assert.match(selectedDocument.directive, /SettingsActivity/)
  assert.match(selectedDocument.directive, /SettingsPage/)

  const { augmentOpencodeMessage } = await import('../src/lib/opencode/opencode-app-scope.ts')
  const selectedDocumentPrompt = await augmentOpencodeMessage(
    '请结合业务知识库文档《设置实现》（wiki/features/账号/设置/implementation.md）分析，并说明当前源码是否仍一致。',
    'KugouLive',
    ['KugouLive'],
    [],
    undefined,
    {
      knowledgeLocator: {
        libraryId: 'fxwiki',
        sourceId: 'fxwiki',
        workspaceAlias: 'fxwiki',
        docPath: 'wiki/features/账号/设置/implementation.md',
        appScopeId: 'KugouLive',
      },
    },
  )
  assert.match(selectedDocumentPrompt.text, /已选知识文档 · 快速核验/)
  assert.match(selectedDocumentPrompt.text, /该文档及关联代码地图已注入下方 L1/)
  assert.doesNotMatch(selectedDocumentPrompt.text, /\[工台强制 · L2 代码图谱\]/)

  const continuedSelectedDocumentPrompt = await augmentOpencodeMessage(
    '请结合业务知识库文档《设置实现》（wiki/features/账号/设置/implementation.md）分析，并说明当前源码是否仍一致。',
    'KugouLive',
    ['KugouLive'],
    [],
    undefined,
    {
      continuity: 'opencode_continue',
      knowledgeLocator: {
        libraryId: 'fxwiki',
        sourceId: 'fxwiki',
        workspaceAlias: 'fxwiki',
        docPath: 'wiki/features/账号/设置/implementation.md',
        appScopeId: 'KugouLive',
      },
    },
  )
  assert.match(continuedSelectedDocumentPrompt.text, /续聊中新知识文档/)
  assert.doesNotMatch(continuedSelectedDocumentPrompt.text, /续聊中新类目标/)

  const genericPackageMiss = await buildOpencodeKnowledgeBundle(
    'com.example.shared.widget.Utils 分析下这个类',
    [{ fqn: 'com.example.shared.widget.Utils', module: 'app_demo' }],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.equal(genericPackageMiss.meta.hit, false)
  assert.doesNotMatch(genericPackageMiss.directive, /账号设置/)

  const miss = await buildOpencodeKnowledgeDirective(
    'legacy.feature.not-registered 的双端入口',
    [],
    undefined,
    { projectId: 'kugou-live' },
  )
  assert.doesNotMatch(miss, /旧关系|legacy_fallback|harmony-kb\/mappings/)

  console.log('test-opencode-knowledge-context: ok')
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
