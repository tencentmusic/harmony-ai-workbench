import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { deletionPlan } from './task-deletion'

const row = { id: 'deltask', appId: 'KugouLive', revision: 2, attachmentIds: '[]', harnessJson: JSON.stringify({ workspace: { identity: 'deltask-2', branch: 'feature/cloud-deltask-2' } }) }

test('deletion stays with the owner and only that task branch', () => {
  assert.throws(() => deletionPlan(row, 'other', 'owner', 'cancelled', false), /只能删除自己创建的任务/)
  assert.throws(() => deletionPlan(row, 'owner', 'owner', 'translating', false), /仍在执行/)
  assert.throws(() => deletionPlan({ ...row, harnessJson: JSON.stringify({ workspace: { identity: 'other-1', branch: 'feature/cloud-other-1' } }) }, 'owner', 'owner', 'cancelled', false), /工作区不属于当前任务/)
  assert.throws(() => deletionPlan({ ...row, harnessJson: JSON.stringify({ workspace: { identity: 'deltask-2', branch: 'kan-fx-release' } }) }, 'owner', 'owner', 'cancelled', false), /分支不属于当前任务/)
  assert.throws(() => deletionPlan({ ...row, harnessJson: JSON.stringify({ workspace: { identity: 'deltask-2', branch: 'feature/cloud-deltask-2' }, delivery: { integrationId: 'cloud-other' } }) }, 'owner', 'owner', 'cancelled', false), /提测记录不属于当前任务/)
  const plan = deletionPlan(row, 'owner', 'owner', 'cancelled', false)
  assert.deepEqual(plan.identities, ['deltask-1', 'deltask-2'])
  assert.equal(plan.branch, 'feature/cloud-deltask-2')
  assert.equal(plan.integrationId, '')
})

test('workspace removal deletes the task worktree, artifacts, materials and remote branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-removal-'))
  const remote = path.join(root, 'remote.git')
  const repo = path.join(root, 'repo')
  const worktrees = path.join(root, 'worktrees')
  const runtime = path.join(root, 'runtime')
  const materials = path.join(root, 'materials')
  const harmony = path.join(worktrees, 'deltask-1', 'harmony')
  const artifact = path.join(runtime, 'tasks', 'deltask-1', 'artifacts', 'note.txt')
  const attachmentId = '11111111-1111-4111-8111-111111111111'
  process.env.CLOUD_AGENT_WORKTREE_ROOT = worktrees
  process.env.CLOUD_AGENT_RUNTIME_ROOT = runtime
  process.env.CLOUD_AGENT_MATERIAL_ROOT = materials
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
  try {
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    execFileSync('git', ['init', repo], { stdio: 'pipe' })
    git(repo, ['config', 'user.email', 'a@b.c'])
    git(repo, ['config', 'user.name', 't'])
    await writeFile(path.join(repo, 'README.md'), 'synthetic')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'init'])
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', 'origin', 'HEAD:refs/heads/main'])
    await mkdir(path.dirname(harmony), { recursive: true })
    git(repo, ['worktree', 'add', '-b', 'feature/cloud-deltask-1', harmony, 'HEAD'])
    git(repo, ['push', 'origin', 'feature/cloud-deltask-1'])
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, 'evidence')
    await mkdir(path.join(materials, attachmentId), { recursive: true })
    await writeFile(path.join(materials, attachmentId, 'original'), 'file')
    const plan = deletionPlan({ id: 'deltask', appId: 'KugouLive', revision: 1, attachmentIds: JSON.stringify([attachmentId]), harnessJson: JSON.stringify({ workspace: { identity: 'deltask-1', branch: 'feature/cloud-deltask-1', harmonyRoot: harmony, artifactRoot: path.dirname(artifact) } }) }, 'owner', 'owner', 'cancelled', false)
    const { removeTaskWorkspace } = await import('./task-removal')
    await removeTaskWorkspace(plan, repo)
    assert.equal(String(git(repo, ['ls-remote', '--heads', 'origin', 'refs/heads/feature/cloud-deltask-1'])).trim(), '')
    await assert.rejects(writeFile(artifact, 'again'))
    await assert.rejects(writeFile(path.join(materials, attachmentId, 'original'), 'again'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
