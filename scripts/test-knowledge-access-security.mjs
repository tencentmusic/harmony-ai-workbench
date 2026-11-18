#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  KnowledgeAccessError,
  readKnowledgeAsset,
  readKnowledgeDocument,
  resetKnowledgeIndexCache,
} from '../src/server/modules/knowledge/public.ts'
import { resetWorkspaceConfigCache } from '../src/lib/workspace-apps-config.ts'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-knowledge-security-'))
const knowledgeRoot = path.join(fixtureRoot, 'knowledge')
const contentRoot = path.join(knowledgeRoot, 'content')
const featureRoot = path.join(contentRoot, 'features')
const sourceRoot = path.join(contentRoot, 'sources')
const outsideRoot = path.join(fixtureRoot, 'outside')
const projectRoot = path.join(fixtureRoot, 'android')
const configPath = path.join(fixtureRoot, 'workspace-apps.json')
const previousConfig = process.env.WORKSPACE_APPS_CONFIG

function write(relativePath, content) {
  const absolute = path.join(contentRoot, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

function expectKnowledgeError(action, code, status) {
  assert.throws(
    action,
    (error) => error instanceof KnowledgeAccessError && error.code === code && error.status === status,
  )
}

try {
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(featureRoot, { recursive: true })
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(outsideRoot, { recursive: true })

  write('features/README.md', [
    '# Fixture',
    '',
    '[linked document](../sources/linked.md)',
    '![linked image](./linked.png)',
    '![hidden image](./.hidden.png)',
    '[escaping image](./escape/outside.png)',
    '[escaping document](./escape/outside.md)',
    '[large file](./large.pdf)',
  ].join('\n'))
  write('features/linked.png', 'linked')
  write('features/.hidden.png', 'hidden')
  write('features/unreferenced.png', 'unreferenced')
  write('sources/linked.md', '# Linked\n\n![nested image](./nested.png)\n')
  write('sources/nested.png', 'nested')
  const largeFile = write('features/large.pdf', 'x')
  fs.truncateSync(largeFile, 20 * 1024 * 1024 + 1)
  fs.writeFileSync(path.join(outsideRoot, 'outside.png'), 'outside')
  fs.writeFileSync(path.join(outsideRoot, 'outside.md'), '# Outside\n')
  fs.symlinkSync(outsideRoot, path.join(featureRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    runtime: { default_profile: 'default' },
    projects: [{
      project_id: 'fixture-project',
      status: 'active',
      sources: {
        android: {
          source_id: 'fixture-android',
          workspace_alias: 'fixture-android',
          locations: { default: { path: projectRoot } },
        },
      },
      apps: [{
        app_id: 'FixtureApp',
        status: 'active',
        scope: { android: { mode: 'whole-repository' } },
      }],
    }],
    shared_knowledge_bases: [{
      id: 'fixture-kb',
      enabled: true,
      workspace_alias: 'fixture-kb',
      connections: { default: { type: 'filesystem', path: knowledgeRoot } },
      query: { content_root: 'content' },
      portal: {
        enabled: true,
        group: 'technical',
        label: 'Fixture KB',
        access: 'authenticated',
        tree_root: 'features',
      },
      capabilities: ['browse', 'document-search'],
    }],
  }, null, 2))

  process.env.WORKSPACE_APPS_CONFIG = configPath
  resetWorkspaceConfigCache()
  resetKnowledgeIndexCache()

  assert.match(readKnowledgeDocument({
    libraryId: 'technical:fixture-kb',
    path: 'sources/linked.md',
    allowedScopeIds: [],
  }).markdown, /Linked/)
  assert.equal(readKnowledgeAsset({
    libraryId: 'technical:fixture-kb',
    path: 'sources/nested.png',
    allowedScopeIds: [],
  }).bytes.toString(), 'nested')

  expectKnowledgeError(() => readKnowledgeAsset({
    libraryId: 'technical:fixture-kb',
    path: 'features/unreferenced.png',
    allowedScopeIds: [],
  }), 'knowledge_asset_type_forbidden', 403)
  expectKnowledgeError(() => readKnowledgeAsset({
    libraryId: 'technical:fixture-kb',
    path: 'features/.hidden.png',
    allowedScopeIds: [],
  }), 'knowledge_asset_type_forbidden', 403)
  expectKnowledgeError(() => readKnowledgeAsset({
    libraryId: 'technical:fixture-kb',
    path: 'features/escape/outside.png',
    allowedScopeIds: [],
  }), 'knowledge_path_forbidden', 403)
  expectKnowledgeError(() => readKnowledgeDocument({
    libraryId: 'technical:fixture-kb',
    path: 'features/escape/outside.md',
    allowedScopeIds: [],
  }), 'knowledge_path_forbidden', 403)
  expectKnowledgeError(() => readKnowledgeAsset({
    libraryId: 'technical:fixture-kb',
    path: 'features/large.pdf',
    allowedScopeIds: [],
  }), 'knowledge_asset_too_large', 413)

  console.log('test:knowledge-access-security OK')
} finally {
  if (previousConfig === undefined) delete process.env.WORKSPACE_APPS_CONFIG
  else process.env.WORKSPACE_APPS_CONFIG = previousConfig
  resetWorkspaceConfigCache()
  resetKnowledgeIndexCache()
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
