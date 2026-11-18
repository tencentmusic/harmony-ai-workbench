import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { androidSyncSources, type CloudProject } from './config'
import { freezeBranch, git, inScope, sourcePrefixes } from './git'
import { nestedWorktree } from './worktrees'
import { scopedPath, sha256 } from './scoped-files'
import { CloudError } from './domain'
import type { HarnessWorkspace } from './harness'

export interface AndroidSourceSnapshot { id: string; suffix: string; sha: string; cache: string; branch: string; configDigest: string }

export async function prepareAndroidSources(workspace: HarnessWorkspace, project: CloudProject, signal: AbortSignal, mr?: { sourceId: string; sha: string; branch?: string }) {
  if (workspace.androidSourceSuffix) throw new CloudError('旧任务只固定了嵌套来源，需新建分析任务生成完整主仓快照', 409)
  const sources = androidSyncSources().filter(source => source.projectIds.includes(project.projectId) && source.suffix && sourcePrefixes(project.androidPrefixes, source.suffix).length).sort((a, b) => a.suffix.length - b.suffix.length || a.id.localeCompare(b.id))
  const snapshots: AndroidSourceSnapshot[] = []
  for (const source of sources) {
    if (!source.branches[0] || !inScope(source.suffix, [''])) throw new CloudError('嵌套仓目录或分支配置不完整', 503)
    const digest = sha256(JSON.stringify(source))
    const receipt = path.join(workspace.artifactRoot, `android-source-${sha256(source.id)}.json`)
    let saved: AndroidSourceSnapshot | null = null
    try { saved = JSON.parse(await readFile(receipt, 'utf8')) as AndroidSourceSnapshot } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const tree = await git(workspace.androidRoot, ['ls-tree', 'HEAD', '--', `:(literal)${source.suffix}`], signal)
    const gitlink = /^160000 commit ([a-f0-9]{40,64})\t/.exec(tree)?.[1]
    const expectedSha = mr?.sourceId === source.id ? mr.sha : gitlink
    const branch = mr?.sourceId === source.id && mr.branch ? mr.branch : source.branches[0]
    if (!source.branches.includes(branch)) throw new CloudError('嵌套 MR 来源分支未配置', 409)
    if (gitlink && expectedSha !== gitlink) throw new CloudError('嵌套 MR 提交与主仓 gitlink 不一致，需明确匹配的主仓基线', 409)
    if (saved) {
      if (saved.configDigest !== digest || saved.id !== source.id || saved.suffix !== source.suffix || (expectedSha && saved.sha !== expectedSha)) throw new CloudError('嵌套源码配置或固定提交变化，需重新分析', 409)
    } else {
      const frozen = await freezeBranch(source.root, branch, signal, expectedSha)
      if (frozen.identity.sourcePrefix) throw new CloudError('嵌套来源须配置为独立 Git 仓根目录', 503)
      saved = { id: source.id, suffix: source.suffix, sha: frozen.sha, cache: frozen.cache, branch, configDigest: digest }
      await writeFile(receipt, JSON.stringify(saved), { flag: 'wx', mode: 0o600 })
    }
    await nestedWorktree(saved.cache, saved.sha, workspace.androidRoot, saved.suffix, signal)
    snapshots.push(saved)
  }
  if (workspace.androidSources && JSON.stringify(workspace.androidSources) !== JSON.stringify(snapshots)) throw new CloudError('任务嵌套来源清单已变化，需重新分析', 409)
  return { ...workspace, androidSources: snapshots }
}

export async function listAndroidFiles(workspace: HarnessWorkspace, signal: AbortSignal) {
  const all: string[] = []
  const sources = [{ suffix: '', root: workspace.androidRoot }, ...(workspace.androidSources || []).map(source => ({ suffix: source.suffix, root: path.join(workspace.androidRoot, source.suffix) }))]
  for (const source of sources) {
    const prefixes = sourcePrefixes(workspace.androidPrefixes, source.suffix)
    if (!prefixes.length) continue
    const files = (await git(source.root, ['ls-files', '-z', '--', ...prefixes.map(prefix => prefix ? `:(literal)${prefix}` : '.')], signal)).split('\0').filter(Boolean)
    all.push(...files.map(file => source.suffix ? `${source.suffix}/${file}` : file).filter(file => inScope(file, workspace.androidPrefixes)))
  }
  return [...new Set(all)]
}

export async function verifyAndroidSources(workspace: HarnessWorkspace, signal: AbortSignal) {
  for (const source of workspace.androidSources || []) {
    const root = await scopedPath(workspace.androidRoot, source.suffix, [''])
    if (await git(root, ['rev-parse', 'HEAD'], signal) !== source.sha || await git(root, ['status', '--porcelain', '--untracked-files=no'], signal)) throw new CloudError('嵌套源码快照已变化，不能沿用旧证据', 409)
  }
}
