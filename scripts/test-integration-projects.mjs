import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadIntegrationProjects, selectableIntegrationProjects, toPublicIntegrationProjects } from '../src/server/modules/integration/integration-projects.ts'
import { parseCreateIntegrationTaskInput } from '../src/server/modules/integration/integration-api.ts'
import { resetWorkspaceConfigCache } from '../src/lib/workspace-apps-config.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-projects-'))
const oldConfig = process.env.WORKSPACE_APPS_CONFIG
try {
  const config = JSON.parse(fs.readFileSync(new URL('../config/workspace-apps.json', import.meta.url), 'utf8'))
  config.projects[0].sources.harmony.locations['local-windows'].path = path.join(root, 'music')
  config.projects[1].sources.harmony.locations['local-windows'].path = path.join(root, 'live')
  const configPath = path.join(root, 'apps.json')
  fs.writeFileSync(configPath, JSON.stringify(config))
  process.env.WORKSPACE_APPS_CONFIG = configPath
  const legacy = { id: 'live', label: '鸿蒙统一工程(live-ktv-merge)', repoRoot: path.join(root, 'legacy'), defaultTargetBranch: 'live-ktv-merge' }
  const env = {
    HARMONY_INTEGRATION_PROJECTS: JSON.stringify([legacy]),
  }
  const projects = loadIntegrationProjects(env)
  const selectable = selectableIntegrationProjects(projects, [])
  assert.deepEqual(selectable.map(p => p.label), ['酷狗大字版', '酷狗唱唱', '酷狗音乐', '酷狗铃声', '酷狗概念版', '未音', '酷狗直播'])
  assert.equal(selectable.length, 7)
  assert.equal(new Set(selectable.map(p => p.id)).size, 7)
  assert.equal(selectable.find(p => p.appScopeId === 'KugouPlayer').repoRoot, path.join(root, 'music'))
  assert.equal(selectable.find(p => p.appScopeId === 'KugouKTV').repoRoot, path.join(root, 'music'))
  assert.equal(selectable.find(p => p.appScopeId === 'KugouLive').repoRoot, path.join(root, 'live'))
  assert.deepEqual(projects.find(p => p.id === 'live'), { ...legacy, scopePath: undefined, selectable: false })
  assert.deepEqual(selectableIntegrationProjects(projects, ['KugouKTV']).map(p => p.label), ['酷狗唱唱'])
  assert.deepEqual(selectableIntegrationProjects(projects, ['unknown']), [])
  assert.ok(selectable.every(p => p.defaultTargetBranch === ''))
  assert.ok(toPublicIntegrationProjects(projects).every(p => !('repoRoot' in p)))

  const allowed = selectableIntegrationProjects(projects, ['KugouKTV'])
  const input = { title: '集成测试', projectId: allowed[0].id, sourceBranch: 'feature/test', targetBranch: 'kan_release' }
  assert.equal(parseCreateIntegrationTaskInput(input, allowed).projectId, allowed[0].id)
  assert.throws(() => parseCreateIntegrationTaskInput({ ...input, targetBranch: undefined }, allowed), e => e.code === 'INVALID_BRANCH')
  assert.throws(() => parseCreateIntegrationTaskInput({ ...input, projectId: 'live' }, allowed), e => e.code === 'PROJECT_NOT_FOUND')
  assert.throws(() => parseCreateIntegrationTaskInput({ ...input, projectId: selectable.find(p => p.appScopeId === 'KugouLive').id }, allowed), e => e.code === 'PROJECT_NOT_FOUND')

  // Missing, inactive, or foreign-platform paths must not silently target another app's repository.
  config.projects[0].apps.find(p => p.app_id === 'KugouElder').status = 'disabled'
  fs.writeFileSync(configPath, JSON.stringify(config))
  resetWorkspaceConfigCache()
  assert.equal(selectableIntegrationProjects(loadIntegrationProjects(env), []).length, 6)
  config.projects[0].sources.harmony.locations['local-windows'].path = ''
  fs.writeFileSync(configPath, JSON.stringify(config))
  resetWorkspaceConfigCache()
  assert.throws(() => loadIntegrationProjects(env), /绝对路径/)
  config.projects[0].sources.harmony.locations['local-windows'].path = path.join(root, 'new-music')
  fs.writeFileSync(configPath, JSON.stringify(config))
  resetWorkspaceConfigCache()
  const changed = loadIntegrationProjects(env)
  assert.equal(changed.find(p => p.appScopeId === 'KugouPlayer').repoRoot, path.join(root, 'new-music'))
  console.log('integration application projects tests passed')
} finally {
  if (oldConfig === undefined) delete process.env.WORKSPACE_APPS_CONFIG
  else process.env.WORKSPACE_APPS_CONFIG = oldConfig
  fs.rmSync(root, { recursive: true, force: true })
}
