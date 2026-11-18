#!/usr/bin/env node
import assert from 'node:assert/strict'
import { describeRepoSyncFollowUps } from '../src/features/admin-console/lib/repoSyncFollowUp.ts'

assert.deepEqual(
  describeRepoSyncFollowUps({}),
  ['仅 git pull'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    pull: { before: 'aaa', after: 'bbb' },
    codegraph: { skipped: true, reason: 'no_codegraph_projects' },
  }),
  ['git pull：已更新', '代码图谱：未配置'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    pull: { before: 'aaa', after: 'aaa' },
    indexing: { skipped: true, reason: 'no_code_change' },
    codegraph: { projects: ['kugou-music'] },
    deploy: { skipped: true, reason: 'no_code_change' },
  }),
  ['git pull：已对齐，无新提交', '类索引：代码无更新，跳过', '代码图谱：已增量更新', '部署：代码无更新，跳过'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    pull: { before: 'aaa', after: 'aaa', preserved: ['fxwiki_config.json'] },
    codegraph: { skipped: true, reason: 'no_codegraph_projects' },
  }),
  ['git pull：已对齐，无新提交，已保留本机配置', '代码图谱：未配置'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    pull: { after: 'ccc' },
    deploy: {
      detached: true,
      reason: 'queued_until_idle',
      commands: [{ command: 'npm run deploy', status: 0 }],
    },
  }),
  ['git pull：已更新', '部署：已交给后台部署'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    deploy: {
      commands: [
        { command: 'bash packages/kb-mcp-gateway/deploy.sh', status: 0 },
        { command: 'bash packages/kb-mcp-codegraph/deploy.sh', status: 0, skipped: true, reason: 'windows_skip_bash' },
      ],
    },
  }),
  ['部署：bash packages/kb-mcp-gateway/deploy.sh；bash packages/kb-mcp-codegraph/deploy.sh（跳过）'],
)

assert.deepEqual(
  describeRepoSyncFollowUps(
    {},
    {
      indexingLabel: '有更新时按仓重建',
      codegraphProjects: ['kugou-live'],
      deployCommands: [['npm', 'run', 'deploy']],
      deployDetached: true,
    },
  ),
  ['git pull', '类索引：有更新时按仓重建', '代码图谱：kugou-live', '部署：已交给后台部署'],
)

assert.deepEqual(
  describeRepoSyncFollowUps({
    pull: { after: 'ccc' },
    indexing: { count: 12, slices: '鸿蒙/KugouPlayer' },
  }),
  ['git pull：已更新', '类索引：已更新 鸿蒙/KugouPlayer'],
)

console.log('test-repo-sync-follow-up: ok')
