import path from 'node:path'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { cloudRoot, git } from './git'
import { materialDirectory } from './materials'
import { requireChildProcessesStopped } from './process-recovery'
import { CloudError } from './domain'
import type { TaskDeletionPlan } from './task-deletion'

async function contained(parent: string, target: string) {
  const normalize = async (value: string) => {
    const resolved = path.resolve(value)
    const canonical = await realpath(resolved).catch(() => resolved)
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  const root = await normalize(parent)
  const resolved = await normalize(target)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return ''
  return resolved
}
function worktreeRoot() {
  const configured = process.env.CLOUD_AGENT_WORKTREE_ROOT
  if (configured && (!path.isAbsolute(configured) || path.resolve(configured) === path.parse(configured).root)) throw new CloudError('工作树根必须是专用绝对目录，不能使用磁盘根目录', 503)
  return path.resolve(configured || path.join(cloudRoot(), 'worktrees'))
}
async function exists(target: string) {
  return !!(await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
}
async function dropWorktree(dir: string, identityDir: string, taskId: string) {
  if (!await exists(dir)) return
  const top = await contained(identityDir, await git(dir, ['rev-parse', '--show-toplevel']))
  if (!top) throw new CloudError('工作树超出任务目录，已停止删除', 409)
  const common = await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const branch = await git(top, ['branch', '--show-current']).catch(() => '')
  const base = common.endsWith(`${path.sep}.git`) || common.endsWith('/.git') ? path.dirname(common) : common
  await git(base, ['worktree', 'remove', '--force', top])
  if (new RegExp(`^feature/cloud-${taskId}-[1-9][0-9]*$`).test(branch)) await git(base, ['branch', '-D', branch]).catch(() => undefined)
}
export async function deleteRemoteTaskBranches(harmonyRoot: string, taskId: string) {
  const output = await git(harmonyRoot, ['ls-remote', '--heads', 'origin', `refs/heads/feature/cloud-${taskId}-*`])
  const names = output.split('\n').flatMap(line => {
    const match = /^[a-f0-9]{40,64}\s+refs\/heads\/(.+)$/.exec(line)
    return match && new RegExp(`^feature/cloud-${taskId}-[1-9][0-9]*$`).test(match[1]) ? [match[1]] : []
  })
  for (const name of names) await git(harmonyRoot, ['push', 'origin', '--delete', name])
  return names
}
export async function removeTaskWorkspace(plan: TaskDeletionPlan, harmonyRoot: string) {
  const trees = worktreeRoot()
  const tasks = path.join(cloudRoot(), 'tasks')
  const identityPattern = new RegExp(`^${plan.id}-[1-9][0-9]*$`)
  const identities = new Set(plan.identities)
  for (const parent of [trees, tasks]) {
    for (const name of await readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error })) if (identityPattern.test(name)) identities.add(name)
  }
  for (const root of plan.artifactRoots) {
    const safe = (await Promise.all([...identities].map(identity => contained(path.join(tasks, identity), root)))).find(Boolean)
    if (!safe) throw new CloudError('任务产物超出任务目录，已停止删除', 409)
    if (await exists(safe)) await requireChildProcessesStopped(safe)
  }
  for (const root of [...plan.harmonyRoots, ...plan.androidRoots]) {
    if (!(await Promise.all([...identities].map(identity => contained(path.join(trees, identity), root)))).some(Boolean)) throw new CloudError('任务工作树超出任务目录，已停止删除', 409)
  }
  if (harmonyRoot) {
    try { await deleteRemoteTaskBranches(harmonyRoot, plan.id) }
    catch (error) { if (plan.branch || plan.harmonyRoots.length) throw error }
  }
  for (const identity of identities) {
    const identityDir = path.join(trees, identity)
    await dropWorktree(path.join(identityDir, 'harmony'), identityDir, plan.id)
    await dropWorktree(path.join(identityDir, 'android'), identityDir, plan.id)
    await rm(identityDir, { recursive: true, force: true })
    await rm(path.join(tasks, identity), { recursive: true, force: true })
  }
  for (const id of plan.attachmentIds) await rm(materialDirectory(id), { recursive: true, force: true })
}
