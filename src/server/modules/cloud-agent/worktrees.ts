import { mkdir, lstat, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { cloudRoot, git } from './git'
import { CloudError } from './domain'
import { scopedPath } from './scoped-files'

export async function nestedWorktree(cache: string, sha: string, parent: string, suffix: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('嵌套源码提交非法')
  const root = await scopedPath(parent, suffix, [''], true)
  const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing && (!existing.isDirectory() || (await readdir(root)).length)) {
    const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
    const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (canonical(await realpath(common)) !== canonical(await realpath(cache)) || await git(root, ['rev-parse', 'HEAD'], signal) !== sha || await git(root, ['status', '--porcelain', '--untracked-files=no'], signal)) throw new CloudError('嵌套源码基线或所属仓库被修改，禁止继续读取', 409)
  } else {
    await mkdir(path.dirname(root), { recursive: true })
    await git(cache, ['worktree', 'add', '--lock', '--detach', root, sha], signal)
  }
  return root
}

export async function taskWorktree(cache: string, sha: string, identity: string, platform: 'android' | 'harmony', signal: AbortSignal) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(identity) || !/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('Worktree 身份非法')
  const configured = process.env.CLOUD_AGENT_WORKTREE_ROOT
  if (configured && (!path.isAbsolute(configured) || /[\x00-\x1f]/.test(configured) || path.resolve(configured) === path.parse(configured).root)) throw new CloudError('工作树根必须是专用绝对目录，不能使用磁盘根目录', 503)
  const parent = path.join(configured || path.join(cloudRoot(), 'worktrees'), identity)
  const root = path.join(parent, platform)
  const branch = `feature/cloud-${identity}`
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new CloudError('任务 Worktree 路径被替换', 503)
    if (await git(root, ['rev-parse', 'HEAD'], signal) !== sha || (platform === 'harmony' && await git(root, ['branch', '--show-current'], signal) !== branch)) throw new CloudError('任务 Worktree 基线或分支变化，需要人工恢复', 503)
    const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
    const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (canonical(await realpath(common)) !== canonical(await realpath(cache))) throw new CloudError('任务 Worktree 所属仓库变化', 503)
  } else {
    await git(cache, ['worktree', 'add', '--lock', ...(platform === 'harmony' ? ['-b', branch] : ['--detach']), root, sha], signal)
  }
  return { root, branch: platform === 'harmony' ? branch : '', sha }
}
