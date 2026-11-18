import path from 'node:path'
import { mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises'
import type { HarnessWorkspace } from './harness'
import { CloudEnvironmentError } from './domain'
import { scopedPath, sha256 } from './scoped-files'

export async function buildOutputRoot(workspace: HarnessWorkspace, cacheRoot?: string) {
  if (!cacheRoot) return workspace.harmonyRoot
  const source = await realpath(workspace.harmonyRoot)
  await mkdir(cacheRoot, { recursive: true })
  const base = await realpath(cacheRoot)
  const overlaps = (a: string, b: string) => { const relative = path.relative(a, b); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
  if (overlaps(base, source) || overlaps(source, base)) throw new CloudEnvironmentError('构建缓存必须与源码工作树分离', 503)
  const root = await scopedPath(base, sha256(source).slice(0, 24), [''], true)
  await mkdir(root, { recursive: true })
  const owner = await scopedPath(root, 'owner.json', [''], true)
  const contents = JSON.stringify({ source, identity: workspace.identity })
  const existing = await readFile(owner, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing === null) {
    if ((await readdir(root)).length) throw new CloudEnvironmentError('构建缓存目录已有内容但没有任务归属，不能接管', 409)
    await writeFile(owner, contents, { flag: 'wx' })
  } else if (existing !== contents) throw new CloudEnvironmentError('构建缓存归属不匹配，不能跨任务复用', 409)
  return root
}
