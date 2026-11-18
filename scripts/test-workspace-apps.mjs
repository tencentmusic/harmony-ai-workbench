#!/usr/bin/env node
/** 自测 workspace-apps → legacy scopes 与路径解析 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findWorkspaceApp,
  loadWorkspaceAppsConfig,
  resolveAppAndroidRepoPath,
  resolveAppHarmonyRepoPath,
  toLegacyScopeRows,
} from './lib/workspace-apps.mjs'
import {
  listWorkspaceLinks,
  normalizeWorkspaceConfig,
  resolveAppKnowledgeSource,
  resolveKnowledgeBase,
  resolveProjectKnowledge,
} from '@kugou/workspace-config'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = loadWorkspaceAppsConfig({ repoRoot })
const scopes = toLegacyScopeRows(config)

assert.equal(scopes.length, 1, `expected 1 active scope, got ${scopes.length}`)

const demo = scopes.find((s) => s.id === 'DemoApp')
assert.equal(demo?.projectId, 'demo-project', 'DemoApp project')
assert.equal(demo?.repositoryId, 'demo-android', 'DemoApp Android source')
assert.equal(demo?.harmonyRepositoryId, 'demo-harmony', 'DemoApp Harmony source')
assert.ok(demo?.prefixes?.includes('src'), 'DemoApp Android prefixes')
assert.ok(demo?.harmonyPrefixes?.includes('entry'), 'DemoApp Harmony prefixes')

const demoApp = findWorkspaceApp('DemoApp', config)
assert.ok(resolveAppAndroidRepoPath(demoApp, config).length > 3, 'DemoApp Android path resolves')
assert.ok(resolveAppHarmonyRepoPath(demoApp, config).length > 3, 'DemoApp Harmony path resolves')

const migrationCases = resolveProjectKnowledge('demo-project', 'migration-cases', config)
assert.equal(migrationCases?.query?.content_root, 'docs', 'migration knowledge content root')
assert.equal(migrationCases?.portal?.tree_root, 'migration', 'migration portal tree')
assert.ok(listWorkspaceLinks(config).some((link) => link.alias === 'migration-cases'), 'migration cases workspace link')
const migrationSource = resolveKnowledgeBase('migration-cases', config)
assert.ok(migrationSource?.root.endsWith(path.join('config', 'demo-migration')))
assert.equal(migrationSource?.query?.content_root, 'docs')
assert.equal(migrationSource?.portal?.tree_root, 'migration')
assert.equal(migrationSource?.portal?.access, 'authenticated')
assert.equal(migrationSource?.portal?.path_targets, undefined)
assert.equal(resolveAppKnowledgeSource('DemoApp', 'migration-cases', config)?.id, 'migration-cases')

const testProfile = loadWorkspaceAppsConfig({ repoRoot, profile: 'test-server', reload: true })
assert.equal(testProfile.active_profile, 'test-server')
assert.ok(findWorkspaceApp('DemoApp', testProfile)?.harmony?.path.endsWith('demo-harmony'), 'test profile path')

const standalone = normalizeWorkspaceConfig({
  schema_version: '2.0',
  runtime: { default_profile: 'test' },
  projects: [{
    project_id: 'standalone',
    label: '独立项目',
    sources: {
      android: { source_id: 'standalone-android', workspace_alias: 'standalone-android-src', locations: { test: { path: 'fixtures/android' } } },
      harmony: { source_id: 'standalone-harmony', workspace_alias: 'standalone-harmony-src', locations: { test: { path: 'fixtures/harmony' } } },
    },
    apps: [{
      app_id: 'StandaloneApp',
      label: '独立 App',
      scope: { android: { mode: 'whole-repository' }, harmony: { mode: 'whole-repository' } },
    }],
    knowledge: [{
      id: 'standalone-kb',
      label: '独立 KB',
      workspace_alias: 'standalone-kb',
      connections: { test: { path: 'fixtures/kb' } },
    }],
  }],
}, { repoRoot, profile: 'test' })
assert.equal(standalone.apps[0].android.match_all, true, 'whole repository Android scope')
assert.equal(standalone.apps[0].harmony.match_all, true, 'whole repository Harmony scope')
assert.ok(resolveProjectKnowledge('standalone', 'standalone-kb', standalone)?.root.endsWith(path.join('fixtures', 'kb')))
assert.ok(listWorkspaceLinks(standalone).some(link => link.alias === 'standalone-kb'))

console.log('test:workspace-apps OK')
