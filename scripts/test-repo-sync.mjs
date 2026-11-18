#!/usr/bin/env node
/**
 * repo-sync 单元测试（matcher / GitLab parse / debounce / deploy-on-change），不执行真实 git pull
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(__dirname, '..'))

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-workspace-'))
const workspaceConfig = JSON.parse(fs.readFileSync('config/workspace-apps.json', 'utf8'))
workspaceConfig.projects[0].sources.android.locations['local-windows'].path = path.join(fixtureRoot, 'android-monorepo')
workspaceConfig.projects[0].sources.harmony.locations['local-windows'].path = path.join(fixtureRoot, 'harmony-music')
workspaceConfig.projects[1].sources.android.locations['local-windows'].path = path.join(fixtureRoot, 'android-live')
workspaceConfig.projects[1].sources.harmony.locations['local-windows'].path = path.join(fixtureRoot, 'harmony-live')
workspaceConfig.shared_knowledge_bases.find(item => item.id === 'fxwiki').connections['local-windows'].path = path.join(fixtureRoot, 'fxwiki')
const workspaceConfigPath = path.join(fixtureRoot, 'workspace-apps.json')
fs.writeFileSync(workspaceConfigPath, JSON.stringify(workspaceConfig))
process.env.WORKSPACE_APPS_CONFIG = workspaceConfigPath

const { parseGitLabWebhook, remoteMatches } = await import('../src/server/modules/repo-sync/gitlab-webhook.ts')
const { matchWebhookEvent, dedupeTargetsByPath } = await import('../src/server/modules/repo-sync/matcher.ts')
const { resetRepoSyncConfigCache, getDeployOnChange, getPreserveLocalFiles } = await import('../src/server/modules/repo-sync/config.ts')
const { pullChanged } = await import('../src/server/modules/repo-sync/deploy-runner.ts')
const { blockingDirtyPaths, parseTrackedDirtyPaths, resolveRepoProjectRoot } = await import('../src/server/modules/repo-sync/git-pull.ts')
const { requireKnowledgeBaseRoot } = await import('../src/server/platform/knowledge-base-root.ts')

resetRepoSyncConfigCache()

{
  const event = parseGitLabWebhook({
    object_kind: 'push',
    ref: 'refs/heads/release',
    after: 'abc123',
    project: { path_with_namespace: 'tme-kugou/android' },
  })
  assert.equal(event.kind, 'push')
  if (event.kind === 'push') {
    assert.equal(event.branch, 'release')
    assert.equal(event.commitSha, 'abc123')
  }
}

{
  const event = parseGitLabWebhook({
    object_kind: 'merge_request',
    project: { path_with_namespace: 'kugouharmony/hmkugou' },
    object_attributes: {
      action: 'merge',
      state: 'merged',
      target_branch: 'live-ktv-merge',
      merge_commit_sha: 'def456',
    },
  })
  assert.equal(event.kind, 'merge')
}

assert.ok(remoteMatches(['tme-kugou/android'], 'tme-kugou/android'))
assert.ok(remoteMatches(['hmkugou'], 'kugouharmony/hmkugou'))

resetRepoSyncConfigCache()

{
  const music = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'kugouharmony/hmkugou',
    branch: 'live-ktv-merge',
    commitSha: 'x',
  })
  assert.ok(music.some((t) => t.repo.id === 'harmony-music'))
  assert.ok(!music.some((t) => t.repo.id === 'harmony-live'))
}

{
  const live = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'kugouharmony/hmkugou',
    branch: 'kan-fx-release',
    commitSha: 'y',
  })
  assert.ok(live.some((t) => t.repo.id === 'harmony-live'))
  assert.ok(!live.some((t) => t.repo.id === 'harmony-music'))
}

{
  const deduped = dedupeTargetsByPath([
    {
      repo: { id: 'a', label: 'a', path: '/tmp/same', remote_match: [], track_branches: [], codegraph_projects: ['kugou-music'] },
      repoPath: '/tmp/same',
      branch: 'release',
      trigger: 'manual',
    },
    {
      repo: { id: 'b', label: 'b', path: '/tmp/same', remote_match: [], track_branches: [], codegraph_projects: ['kugou-live'] },
      repoPath: '/tmp/same',
      branch: 'release',
      trigger: 'manual',
    },
  ])
  assert.equal(deduped.length, 1)
  assert.ok(deduped[0].codegraphProjects.includes('kugou-music'))
  assert.ok(deduped[0].codegraphProjects.includes('kugou-live'))
}

resetRepoSyncConfigCache()

{
  const music = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'fanxingallinone-android/fanxingallinone',
    branch: 'kan-release',
    commitSha: 'fa1',
  })
  assert.equal(music.length, 1, 'fanxingallinone kan-release 只跟音乐内嵌')
  assert.equal(music[0].repo.id, 'fanxingallinone-music')
  assert.ok(music[0].repoPath.replace(/\\/g, '/').endsWith('android-monorepo/fanxingallinone'))

  const live = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'fanxingallinone-android/fanxingallinone',
    branch: 'release',
    commitSha: 'fa2',
  })
  assert.equal(live.length, 1, 'fanxingallinone release 只跟直播内嵌')
  assert.equal(live[0].repo.id, 'fanxingallinone-live')
  assert.ok(live[0].repoPath.replace(/\\/g, '/').endsWith('android-live/fanxingallinone'))
}

resetRepoSyncConfigCache()

{
  const targets = matchWebhookEvent({
    kind: 'merge',
    remoteKey: 'xiaoshifeng/kugou-harmony-ai-workbench',
    branch: 'release',
    commitSha: 'wb1',
  })
  assert.equal(targets.length, 1, 'workbench release should match')
  assert.equal(targets[0].repo.id, 'kugou-harmony-ai-workbench')
}

{
  const ignored = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'xiaoshifeng/kugou-harmony-ai-workbench',
    branch: 'feature/foo',
    commitSha: 'wb2',
  })
  assert.equal(ignored.length, 0, 'workbench non-release should not match')
}

{
  const targets = matchWebhookEvent({
    kind: 'push',
    remoteKey: 'LiveAndroid/fxwiki',
    branch: 'master',
    commitSha: 'fx1',
  })
  assert.equal(targets.length, 1, 'fxwiki master should match')
  assert.equal(targets[0].repo.id, 'fxwiki')
}

assert.equal(pullChanged({ before: 'a', after: 'a' }), false)
assert.equal(pullChanged({ before: 'a', after: 'b' }), true)
assert.equal(pullChanged({ skipped: true, after: 'b' }), false)
assert.equal(pullChanged({ after: 'b' }), true)

assert.equal(getDeployOnChange(['android-harmony-kb']), null)
assert.equal(getDeployOnChange(['migration-cases']), null)
assert.equal(getDeployOnChange(['kugou-harmony-ai-workbench'])?.detached, true)
assert.equal(getDeployOnChange(['fxwiki']), null)
assert.deepEqual(getPreserveLocalFiles(['fxwiki']), ['fxwiki_config.json'])
assert.deepEqual(getPreserveLocalFiles(['android-harmony-kb']), [])
assert.deepEqual(parseTrackedDirtyPaths(' M fxwiki_config.json\n M README.md\n'), [
  'fxwiki_config.json',
  'README.md',
])
assert.deepEqual(
  parseTrackedDirtyPaths(' M fxwiki_config.json\n'.replace(/\s+$/u, '')),
  ['fxwiki_config.json'],
  'git status porcelain must keep the leading status space',
)
assert.deepEqual(blockingDirtyPaths(['fxwiki_config.json'], ['fxwiki_config.json']), [])
assert.deepEqual(blockingDirtyPaths(['fxwiki_config.json', 'README.md'], ['fxwiki_config.json']), [
  'README.md',
])

assert.equal(resolveRepoProjectRoot(process.cwd()), path.resolve(process.cwd()))
assert.equal(
  requireKnowledgeBaseRoot(),
  path.resolve(process.cwd(), 'packages/android-harmony-kb'),
  '内置 KB 应使用当前 CodeGraph CLI 入口判定可用，不依赖已删除的旧 registry',
)

{
  const { sortQueuedJobs } = await import('../src/server/modules/repo-sync/queue.ts')
  const sorted = sortQueuedJobs([
    {
      runId: 'wb',
      repoIds: ['kugou-harmony-ai-workbench'],
      repoPath: '/wb',
      branch: 'release',
      trigger: 'webhook:push',
      codegraphProjects: [],
      enqueuedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      runId: 'source',
      repoIds: ['android-monorepo'],
      repoPath: '/android',
      branch: 'release',
      trigger: 'webhook:push',
      codegraphProjects: [],
      enqueuedAt: '2026-01-01T00:00:01.000Z',
    },
    {
      runId: 'knowledge',
      repoIds: ['fxwiki'],
      repoPath: '/knowledge',
      branch: 'release',
      trigger: 'webhook:push',
      codegraphProjects: [],
      enqueuedAt: '2026-01-01T00:00:02.000Z',
    },
  ])
  assert.deepEqual(
    sorted.map((j) => j.runId),
    ['source', 'knowledge', 'wb'],
    '工台自部署必须排到队列最后，避免先 reload worker',
  )
}

console.log('test:repo-sync ok')
fs.rmSync(fixtureRoot, { recursive: true, force: true })
