#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeWorkspaceConfig } from '@kugou/workspace-config'
import { buildFeatureContextPack } from '../lib/feature-context-pack.mjs'
import {
  listKnowledgeSources,
  readKnowledge,
  resolveKnowledgeCounterpart,
  resolveKnowledgeFeatureContext,
  resetKnowledgeSourceCache,
  searchKnowledge,
} from '../lib/knowledge-source-runtime.mjs'
import { buildCodegraphGatewayToolList, buildMcpToolList } from '../lib/mcp-tool-copy.mjs'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-fxwiki-'))
const fxwikiRoot = path.join(fixtureRoot, 'fxwiki')
const contentRoot = path.join(fxwikiRoot, 'android_wiki')
const manifestRoot = path.join(contentRoot, 'wiki', 'indexes', 'manifest')
const routeRoot = path.join(manifestRoot, 'routes')
const liveFeatureRoot = path.join(contentRoot, 'wiki', 'features', '账号', '设置')
const musicFeatureRoot = path.join(contentRoot, 'wiki', 'features', '音乐', '搜索')

function write(relative, content) {
  const target = path.join(fixtureRoot, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

function buildConfig(enabled = true, sourceRoot = fxwikiRoot) {
  return normalizeWorkspaceConfig({
    schema_version: '2.0',
    runtime: { default_profile: 'test' },
    shared_knowledge_bases: [{
      id: 'fxwiki',
      label: 'fxwiki fixture',
      provider: 'fxwiki',
      enabled,
      workspace_alias: 'fxwiki',
      connections: { test: { path: sourceRoot } },
      query: {
        adapter: 'feature-manifest-v1',
        content_root: 'android_wiki',
        project_targets: {
          'kugou-live': ['kugou_live.android', 'kugou_live.harmony'],
          'kugou-music': ['kugou_music.android', 'kugou_music.harmony'],
        },
      },
      capabilities: ['document-search', 'mcp-query'],
    }],
    projects: [
      {
        project_id: 'kugou-live',
        label: '直播',
        sources: { android: { source_id: 'live', locations: { test: { path: fixtureRoot } } } },
        apps: [{ app_id: 'Live', scope: { android: { mode: 'whole-repository' } } }],
        knowledge: [{ use: 'fxwiki' }],
      },
      {
        project_id: 'kugou-music',
        label: '音乐',
        sources: { android: { source_id: 'music', locations: { test: { path: fixtureRoot } } } },
        apps: [{ app_id: 'Music', scope: { android: { mode: 'whole-repository' } } }],
        knowledge: [{ use: 'fxwiki' }],
      },
    ],
  }, { repoRoot: fixtureRoot, profile: 'test' })
}

try {
  fs.mkdirSync(routeRoot, { recursive: true })
  fs.mkdirSync(liveFeatureRoot, { recursive: true })
  fs.mkdirSync(musicFeatureRoot, { recursive: true })

  write('fxwiki/android_wiki/wiki/indexes/manifest/catalog.json', JSON.stringify({
    schema_version: 1,
    validation: { status: 'passed' },
    features: [
      {
        feature_id: 'account_settings',
        title: '账号设置',
        aliases: ['设置与帮助'],
        summary: '管理悬浮窗与后台播放。',
        breadcrumb: ['账号', '设置'],
        applies_to: ['kugou_live.android', 'kugou_live.harmony'],
        canonical_readme: 'wiki/features/账号/设置/README.md',
        route_shard: '账号',
        confidence: 'high',
      },
      {
        feature_id: 'music_search',
        title: '音乐搜索',
        aliases: ['搜歌'],
        summary: '搜索歌曲。',
        breadcrumb: ['音乐', '搜索'],
        applies_to: ['kugou_music.android'],
        canonical_readme: 'wiki/features/音乐/搜索/README.md',
        route_shard: '音乐',
        confidence: 'high',
      },
      {
        feature_id: 'account_interaction',
        title: '账号互动',
        aliases: [],
        summary: '账号互动设置。',
        breadcrumb: ['账号', '互动'],
        applies_to: ['kugou_live.android'],
        canonical_readme: 'wiki/features/账号/互动/README.md',
        route_shard: '账号',
        confidence: 'high',
      },
    ],
  }, null, 2))
  write('fxwiki/android_wiki/wiki/indexes/manifest/symbols.jsonl', `${[
    {
      feature_id: 'account_settings',
      symbol: 'com.example.SettingsActivity#onCreate(Bundle)',
      class_fqn: 'com.example.SettingsActivity',
      simple_name: 'SettingsActivity',
      targets: ['kugou_live.android'],
      read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
    },
    {
      feature_id: 'account_interaction',
      symbol: 'com.example.SettingsActivity#onClick(View)',
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
  ].map((row) => JSON.stringify(row)).join('\n')}\n`)
  write('fxwiki/android_wiki/wiki/indexes/manifest/routes/账号.json', JSON.stringify({
    routes: [
      {
        feature_id: 'account_settings',
        intent: 'overview',
        phrases: [{ phrase: '悬浮窗权限' }],
        read: ['wiki/features/账号/设置/implementation#核心流程'],
        targets: ['kugou_live.android', 'kugou_live.harmony'],
        source_chain: ['wiki/features/账号/设置/README.md'],
      },
      {
        feature_id: 'account_interaction',
        intent: 'code_entry',
        phrases: [{ phrase: 'onCreate' }],
        read: ['wiki/features/账号/设置/code_map/live_android#主链路 FQN'],
        targets: ['kugou_live.android'],
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
  }, null, 2))
  write('fxwiki/android_wiki/wiki/indexes/manifest/routes/音乐.json', JSON.stringify({ routes: [] }, null, 2))
  write('fxwiki/android_wiki/wiki/features/账号/设置/README.md', '# 账号设置\n\n## 模块定位\n\n管理设置入口。\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/implementation.md', '# 设置实现\n\n## 核心流程\n\n先校验权限，再启用悬浮窗。\n\n## 其他\n\n不应被章节读取返回。\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/code_map/live_android.md', '# 代码地图\n\n## 主链路 FQN\n\n`com.example.SettingsActivity`\n')
  write('fxwiki/android_wiki/wiki/features/账号/设置/code_map/live_harmony.md', '# 鸿蒙代码地图\n\n## 主链路 FQN\n\n`com.example.SettingsPage`\n')
  write('fxwiki/android_wiki/wiki/features/音乐/搜索/README.md', '# 音乐搜索\n')

  const config = buildConfig()
  const listed = listKnowledgeSources({ project_id: 'kugou-live' }, { config })
  assert.equal(listed.source_count, 1)
  assert.equal(listed.sources[0].source_id, 'fxwiki')
  assert.equal(listed.sources[0].available, true)

  const byAlias = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: '设置与帮助',
  }, { config })
  assert.equal(byAlias.results[0].feature_id, 'account_settings')

  const byRoute = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: '悬浮窗权限',
    target: 'kugou_live.android',
  }, { config })
  assert.equal(byRoute.results[0].feature_id, 'account_settings')
  assert.equal(byRoute.results[0].routes[0].read[0], 'wiki/features/账号/设置/implementation#核心流程')

  const bySymbol = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: 'SettingsActivity',
  }, { config })
  assert.equal(bySymbol.results[0].symbols[0].class_fqn, 'com.example.SettingsActivity')

  const byExactMember = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: 'com.example.SettingsActivity#onCreate(Bundle)',
  }, { config })
  assert.equal(byExactMember.results[0].feature_id, 'account_settings')
  assert.equal(byExactMember.results[0].symbols[0].symbol, 'com.example.SettingsActivity#onCreate(Bundle)')

  const byDocumentPath = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: 'wiki/features/账号/设置/code_map/live_android.md',
  }, { config })
  assert.equal(byDocumentPath.results[0].feature_id, 'account_settings')
  assert.equal(byDocumentPath.results[0].match_reasons.includes('doc_ref'), true)
  assert.deepEqual(byDocumentPath.retrieval.route_shards, ['账号'])

  const isolated = searchKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    query: '音乐搜索',
  }, { config })
  assert.equal(isolated.result_count, 0, 'live project must not see music-only feature')
  assert.throws(
    () => searchKnowledge({
      project_id: 'kugou-live',
      source_id: 'fxwiki',
      query: '设置',
      target: 'kugou_music.android',
    }, { config }),
    /knowledge_target_not_allowed/,
  )

  const feature = readKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    feature_id: 'account_settings',
  }, { config })
  assert.match(feature.document.content, /管理设置入口/)
  assert.equal(feature.routes.length, 3)

  const section = readKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    doc_ref: 'wiki/features/账号/设置/implementation#核心流程',
    target: 'kugou_live.android',
  }, { config })
  assert.match(section.document.content, /先校验权限/)
  assert.doesNotMatch(section.document.content, /不应被章节读取返回/)
  const codeMap = readKnowledge({
    project_id: 'kugou-live',
    source_id: 'fxwiki',
    doc_ref: 'wiki/features/账号/设置/code_map/live_android#主链路%20FQN',
    target: 'kugou_live.android',
  }, { config })
  assert.match(codeMap.document.content, /SettingsActivity/)

  const context = resolveKnowledgeFeatureContext({
    project_id: 'kugou-live',
    feature_id: 'account_settings',
  }, { config })
  assert.equal(context.hit, true)
  assert.equal(context.cross_platform_ready, true)
  assert.equal(context.platforms.android.symbols[0].simple_name, 'SettingsActivity')
  assert.equal(context.platforms.harmonyos.symbols[0].simple_name, 'SettingsPage')

  const symbolContext = resolveKnowledgeFeatureContext({
    project_id: 'kugou-live',
    hints: ['com.example.SettingsActivity#onCreate(Bundle)'],
  }, { config })
  assert.equal(symbolContext.hit, true)
  assert.equal(symbolContext.feature_id, 'account_settings')
  assert.equal(symbolContext.match_by, 'symbol')
  assert.deepEqual(symbolContext.retrieval.route_shards, ['账号'])
  assert.deepEqual(symbolContext.retrieval.read_refs, ['wiki/features/账号/设置/code_map/live_android.md#主链路 FQN'])
  assert.match(symbolContext.documents[0].content, /SettingsActivity/)
  assert.doesNotMatch(symbolContext.documents[0].content, /管理设置入口/)

  const counterpart = resolveKnowledgeCounterpart({
    project_id: 'kugou-live',
    symbol: 'com.example.SettingsActivity#onCreate(Bundle)',
    from_platform: 'android',
  }, { config })
  assert.equal(counterpart.hit, true)
  assert.equal(counterpart.source_id, 'fxwiki')
  assert.equal(counterpart.harmonyos.entry, 'com.example.SettingsPage')

  const pack = buildFeatureContextPack({
    project_id: 'kugou-live',
    feature_id: 'account_settings',
    config,
  })
  assert.equal(pack.primary_source, 'fxwiki')
  assert.equal(pack.source_strategy, 'manifest_only')
  assert.equal(pack.mappings.cross_platform_ready, true)
  assert.equal('legacy_fallback' in pack, false)

  const genericConfig = buildConfig()
  genericConfig.shared_knowledge_bases[0].id = 'team-knowledge'
  genericConfig.shared_knowledge_bases[0].label = 'Team knowledge fixture'
  for (const project of genericConfig.projects) project.knowledge = [{ use: 'team-knowledge' }]
  const genericContext = resolveKnowledgeFeatureContext({
    project_id: 'kugou-live',
    feature_id: 'account_settings',
  }, { config: genericConfig })
  assert.equal(genericContext.hit, true)
  assert.equal(genericContext.source_id, 'team-knowledge')

  const missingPack = buildFeatureContextPack({
    project_id: 'kugou-live',
    feature_id: 'legacy.account.settings',
    config,
  })
  assert.match(missingPack.error, /feature not found/)
  assert.throws(
    () => readKnowledge({
      project_id: 'kugou-live',
      source_id: 'fxwiki',
      doc_ref: '../../secret',
    }, { config }),
    /knowledge_doc_ref_invalid/,
  )
  assert.throws(
    () => readKnowledge({
      project_id: 'kugou-live',
      source_id: 'fxwiki',
      doc_ref: 'wiki/features/音乐/搜索/README.md',
    }, { config }),
    /knowledge_doc_ref_not_allowed/,
  )

  const disabled = listKnowledgeSources({ project_id: 'kugou-live' }, { config: buildConfig(false) })
  assert.equal(disabled.source_count, 0)
  const missing = listKnowledgeSources(
    { project_id: 'kugou-live' },
    { config: buildConfig(true, path.join(fixtureRoot, 'missing-fxwiki')) },
  )
  assert.equal(missing.sources[0].available, false)
  assert.match(missing.sources[0].error, /knowledge_source_unavailable/)

  for (const surface of ['stdio', 'gateway']) {
    const names = buildMcpToolList(surface).map((tool) => tool.name)
    assert.ok(names.includes('kb_knowledge_sources'))
    assert.ok(names.includes('kb_knowledge_search'))
    assert.ok(names.includes('kb_knowledge_read'))
  }
  const codegraph = buildCodegraphGatewayToolList()
  assert.equal(codegraph.length, 8)
  assert.equal(codegraph.some((tool) => tool.name.startsWith('kb_knowledge_')), false)

  console.log('test:knowledge-sources OK')
} finally {
  resetKnowledgeSourceCache()
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
