import assert from 'node:assert/strict'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { taskWorktree } from './worktrees'
import { git } from './git'

test('new worktrees use the configured root without moving runtime archives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-root-'))
  const old = process.env.CLOUD_AGENT_WORKTREE_ROOT
  try {
    const repo = path.join(root, 'repo'), short = path.join(root, 'short')
    await mkdir(repo)
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.email', 'test@example.invalid'])
    await git(repo, ['config', 'user.name', 'Test'])
    await writeFile(path.join(repo, 'source.txt'), 'test')
    await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'base'])
    const sha = await git(repo, ['rev-parse', 'HEAD'])
    process.env.CLOUD_AGENT_WORKTREE_ROOT = short
    const one = await taskWorktree(path.join(repo, '.git'), sha, 'task-one', 'harmony', AbortSignal.timeout(20000))
    assert.equal(one.root, path.join(short, 'task-one', 'harmony'))
    assert.equal((await taskWorktree(path.join(repo, '.git'), sha, 'task-one', 'harmony', AbortSignal.timeout(20000))).root, one.root)
    process.env.CLOUD_AGENT_WORKTREE_ROOT = 'relative'
    await assert.rejects(taskWorktree(path.join(repo, '.git'), sha, 'task-two', 'harmony', AbortSignal.timeout(20000)), /专用绝对目录/)
  } finally {
    if (old === undefined) delete process.env.CLOUD_AGENT_WORKTREE_ROOT
    else process.env.CLOUD_AGENT_WORKTREE_ROOT = old
    await rm(root, { recursive: true, force: true })
  }
})
