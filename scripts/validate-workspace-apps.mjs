#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadWorkspaceAppsConfig,
  resolveAppAndroidRepoPath,
  resolveAppHarmonyRepoPath,
  resolveAppKnowledgeSource,
  resolveDocument,
  resolveKnowledgeBase,
  toLegacyScopeRows,
} from './lib/workspace-apps.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let errors = 0
let warnings = 0

function fail(msg) {
  console.error(`ERROR: ${msg}`)
  errors += 1
}

function warn(msg) {
  console.warn(`WARN: ${msg}`)
  warnings += 1
}

function checkPath(label, resolved) {
  if (!resolved) {
    warn(`${label}: 当前 profile 未配置路径`)
    return
  }
  if (!fs.existsSync(resolved)) {
    warn(`${label}: 路径不存在 ${resolved}`)
  }
}

try {
  const config = loadWorkspaceAppsConfig({ repoRoot })
  const ids = new Set()

  for (const project of config.projects) {
    for (const platform of ['android', 'harmony']) {
      const source = project.sources?.[platform]
      if (!source) continue
      if (!source.source_id) fail(`${project.project_id}: sources.${platform}.source_id 缺失`)
      if (!source.workspace_alias) fail(`${project.project_id}: sources.${platform}.workspace_alias 缺失`)
      checkPath(`${project.project_id}/${platform}`, source.resolved_path)
    }
    for (const document of project.documents || []) {
      checkPath(
        `${project.project_id}/documents/${document.id}`,
        resolveDocument(project.project_id, document.id, config)?.root,
      )
    }
  }

  for (const knowledgeBase of config.shared_knowledge_bases || []) {
    const capabilities = Array.isArray(knowledgeBase.capabilities) ? knowledgeBase.capabilities : []
    if (knowledgeBase.portal?.enabled) {
      if (!['technical', 'migration'].includes(knowledgeBase.portal.group)) {
        fail(`${knowledgeBase.id}: portal.group 仅支持 technical 或 migration`)
      }
      if (knowledgeBase.portal.access !== 'authenticated') fail(`${knowledgeBase.id}: 共享知识门户必须使用 authenticated`)
      if (!knowledgeBase.portal.label?.trim()) fail(`${knowledgeBase.id}: portal.label 缺失`)
      if (!knowledgeBase.portal.tree_root?.trim()) fail(`${knowledgeBase.id}: portal.tree_root 缺失`)
      if (!knowledgeBase.query?.content_root) fail(`${knowledgeBase.id}: 知识门户缺少 query.content_root`)
      const appIds = new Set(config.apps.map((app) => app.app_id))
      for (const [prefix, appId] of Object.entries(knowledgeBase.portal.path_targets || {})) {
        if (!String(prefix).trim()) fail(`${knowledgeBase.id}: portal.path_targets 存在空目录`)
        if (!appIds.has(appId)) fail(`${knowledgeBase.id}: portal.path_targets 指向未知 App ${appId}`)
      }
    }
    if (capabilities.includes('mcp-query')) {
      if (!knowledgeBase.workspace_alias) fail(`${knowledgeBase.id}: mcp-query 缺少 workspace_alias`)
      if (!knowledgeBase.query?.adapter) fail(`${knowledgeBase.id}: mcp-query 缺少 query.adapter`)
      if (!knowledgeBase.query?.content_root) fail(`${knowledgeBase.id}: mcp-query 缺少 query.content_root`)
      for (const project of config.projects) {
        const bound = (project.knowledge || []).some(
          (entry) => entry.use === knowledgeBase.id || entry.id === knowledgeBase.id,
        )
        if (bound && !knowledgeBase.query?.project_targets?.[project.project_id]?.length) {
          fail(`${knowledgeBase.id}: 缺少 ${project.project_id} 的 query.project_targets`)
        }
      }
    }
    checkPath(
      `shared_knowledge_bases/${knowledgeBase.id}`,
      resolveKnowledgeBase(knowledgeBase.id, config)?.root,
    )
  }

  for (const app of config.apps) {
    const sid = String(app.scope_id || '').trim()
    if (!sid) {
      fail('apps[] 存在空 scope_id')
      continue
    }
    if (ids.has(sid)) fail(`重复 scope_id: ${sid}`)
    ids.add(sid)
    if (!app.label?.trim()) fail(`${sid}: label 缺失`)
    if (!app.android && !app.harmony) fail(`${sid}: android 与 harmony 至少配置一项`)
    if (app.android) {
      if (!app.android.path) fail(`${sid}: android 源码路径未解析`)
      if (!app.android.prefixes?.length && !app.android.match_all) {
        fail(`${sid}: android.modules 不能为空（除非 mode=whole-repository）`)
      }
      checkPath(`${sid}/android`, resolveAppAndroidRepoPath(app, config))
    }
    if (app.harmony) {
      if (!app.harmony.path) fail(`${sid}: harmony 源码路径未解析`)
      if (!app.harmony.prefixes?.length && !app.harmony.match_all) {
        fail(`${sid}: harmony.prefixes 不能为空（除非 match_all）`)
      }
      checkPath(`${sid}/harmony`, resolveAppHarmonyRepoPath(app, config))
    }
    for (const binding of app.knowledge_sources || []) {
      const id = binding.id || binding.use
      const source = resolveAppKnowledgeSource(sid, id, config)
      if (!source) fail(`${sid}: knowledge_sources/${id} 未解析`)
      else checkPath(`${sid}/knowledge_sources/${id}`, source.content_root || source.root)
    }
  }

  const legacy = toLegacyScopeRows(config)
  if (legacy.length !== config.apps.filter((a) => String(a.status || 'active') === 'active').length) {
    fail('toLegacyScopeRows 行数与 active apps 不一致')
  }

  console.log(`validate:workspace-apps OK (${legacy.length} scopes, ${warnings} warnings)`)
  if (errors) process.exit(1)
} catch (e) {
  fail(String(e?.message || e))
  process.exit(1)
}
