import path from 'node:path'
import { mkdtemp, rm, readFile, writeFile, stat, realpath } from 'node:fs/promises'
import { git, inScope } from './git'
import { scopedPath, sha256, inProjectScope, relativeToRoot } from './scoped-files'
import { documentPrefix, type DocumentOverlay } from './branch-documents'
import { CloudError, record } from './domain'
import { gitlabRequestFor } from './gitlab-access'

export async function snapshotCommit(root: string, base: string, prefixes: string[], artifactRoot: string, title: string, signal: AbortSignal, parent = base, documents?: DocumentOverlay, expectedHead = base) {
  if (![parent, base, expectedHead].every(value => /^[a-f0-9]{40,64}$/.test(value))) throw new CloudError('交付提交身份非法')
  if (await git(root, ['rev-parse', 'HEAD'], signal) !== expectedHead) throw new CloudError('已验收 HEAD 发生变化，不能提测', 409)
  if (expectedHead !== base) {
    const ancestor = await git(root, ['merge-base', base, expectedHead], signal).catch(() => { signal.throwIfAborted(); return '' })
    if (ancestor !== base) throw new CloudError('登记 HEAD 不是原始基线的后继，不能提测', 409)
  }
  const names = [...new Set([
    ...(await git(root, ['diff', '--name-only', '--no-renames', '--relative', '-z', base], signal)).split('\0'),
    ...(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0'),
  ].filter(Boolean))]
  if (!names.length || names.some(name => !inProjectScope(name, prefixes))) throw new CloudError('提交必须包含当前任务项目范围内文件，不能夹带其他改动', 409)
  for (const name of names) await scopedPath(root, name, prefixes, true, true)
  const temp = await mkdtemp(path.join(artifactRoot, 'git-index-'))
  const env = { GIT_INDEX_FILE: path.join(temp, 'index'), GIT_AUTHOR_NAME: 'Cloud Agent', GIT_AUTHOR_EMAIL: 'cloud-agent@localhost', GIT_COMMITTER_NAME: 'Cloud Agent', GIT_COMMITTER_EMAIL: 'cloud-agent@localhost' }
  try {
    await git(root, ['read-tree', base], signal, env)
    await git(root, ['add', '-A', '--', ...names.map(n => `:(literal)${n}`)], signal, env)
    const codeTree = await git(root, ['write-tree'], signal, env)
    if (documents) {
      const artifactCanonical = await realpath(artifactRoot)
      const suffix = `/${documents.appId}/${documents.identity}`
      if (!documents.prefix.endsWith(suffix) || documentPrefix(documents.prefix.slice(0, -suffix.length), documents.appId, documents.identity) !== documents.prefix || !documents.files.length || documents.files.length > 100) throw new CloudError('分支文档范围非法', 409)
      if (names.some(name => inScope(name, [documents.prefix]))) throw new CloudError('源码工作区存在同名文档改动，未覆盖', 409)
      const repoPrefix = await git(root, ['rev-parse', '--show-prefix'], signal)
      if (await git(root, ['ls-tree', '-r', '--name-only', base, '--', `:(literal)${documents.prefix}`], signal)) throw new CloudError('基线已包含该任务文档目录，未覆盖', 409)
      const seen = new Set<string>()
      let total = 0
      for (const file of documents.files) {
        if (!/^(?:README\.md|[a-z0-9-]+\.(?:md|json)|assets\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp))$/.test(file.name) || seen.has(file.name)) throw new CloudError('分支文档文件类型或名称非法', 409)
        seen.add(file.name)
        const source = await scopedPath(artifactCanonical, await relativeToRoot(artifactRoot, file.source), ['branch-documents'])
        const size = (await stat(source)).size
        total += size
        if (size > 10 * 1024 * 1024 || total > 40 * 1024 * 1024) throw new CloudError('分支文档大小超限', 413)
        const bytes = await readFile(source)
        if (sha256(bytes) !== file.sha256) throw new CloudError('分支文档摘要不一致', 409)
        const target = `${documents.prefix}/${file.name}`
        await scopedPath(root, target, [documents.prefix], true)
        const input = path.join(temp, 'document-blob')
        await writeFile(input, bytes)
        const blob = await git(root, ['hash-object', '-w', '--no-filters', '--', input], signal, env)
        await git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${repoPrefix}${target}`], signal, env)
      }
    }
    const tree = await git(root, ['write-tree'], signal, env)
    const sha = await git(root, ['commit-tree', tree, '-p', parent, '-m', title], signal, env)
    return { sha, tree, base, codeTree }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
export async function pushSnapshot(root: string, remote: string, branch: string, sha: string, signal: AbortSignal, expected = '') {
  const ref = `refs/heads/${branch}`
  const current = (await git(root, ['ls-remote', '--heads', remote, ref], signal)).split(/\s/)[0]
  if (current === sha) return
  if (current !== expected) throw new CloudError('交付分支已被其他提交占用，未覆盖远程分支', 409)
  if (expected) await git(root, ['merge-base', '--is-ancestor', expected, sha], signal)
  await git(root, ['push', `--force-with-lease=${ref}:${expected}`, remote, `${sha}:${ref}`], signal)
}
export async function requireOpenMR(mr: DeliveryMR, signal: AbortSignal, request = gitlabRequest) {
  const row = record(await request(mr.origin, `/projects/${encodeURIComponent(mr.repository)}/merge_requests/${mr.iid}`, signal))
  validateMR(row, mr)
  if (row.state !== 'opened') throw new CloudError('MR 不再处于打开状态，不能返修或更新', 409)
}
export const gitlabRequest = gitlabRequestFor()
export interface DeliveryMR { iid: number; url: string; sha: string; branch: string; target: string; origin: string; repository: string; mergedSha?: string; sourceRoot?: string }
export function validateMR(value: unknown, expected: Omit<DeliveryMR, 'iid' | 'url'>): DeliveryMR {
  const row = record(value)
  if (!Number.isSafeInteger(row.iid) || Number(row.iid) < 1 || row.source_branch !== expected.branch || row.target_branch !== expected.target || row.sha !== expected.sha || (row.source_project_id !== undefined && row.source_project_id !== row.target_project_id)) throw new CloudError('MR 身份或源提交与已验收快照不一致', 409)
  const url = new URL(String(row.web_url))
  if (url.origin !== expected.origin || !url.pathname.startsWith(`/${expected.repository}/-/merge_requests/`)) throw new CloudError('MR 地址不属于配置仓库', 409)
  return { ...expected, iid: Number(row.iid), url: url.href }
}
export async function ensureMR(expected: Omit<DeliveryMR, 'iid' | 'url'>, title: string, signal: AbortSignal, request = gitlabRequest) {
  const base = `/projects/${encodeURIComponent(expected.repository)}/merge_requests`
  const rows = await request(expected.origin, `${base}?scope=all&source_branch=${encodeURIComponent(expected.branch)}&target_branch=${encodeURIComponent(expected.target)}&per_page=100`, signal)
  if (!Array.isArray(rows) || rows.length > 1) throw new CloudError('MR 查询结果不唯一', 409)
  const row = rows.length ? rows[0] : await request(expected.origin, base, signal, { source_branch: expected.branch, target_branch: expected.target, title, remove_source_branch: false, description: '由云Agent基于 Harness delivery_ready 证据创建。请完成代码审查与测试后合入。' })
  if (record(row).state === 'closed') throw new CloudError('交付 MR 已关闭，需人工处理', 409)
  return validateMR(row, expected)
}
export async function findDeliveryMR(expected: Omit<DeliveryMR, 'iid' | 'url'>, signal: AbortSignal, request = gitlabRequest): Promise<DeliveryMR | null> {
  const base = `/projects/${encodeURIComponent(expected.repository)}/merge_requests`
  const rows = await request(expected.origin, `${base}?scope=all&source_branch=${encodeURIComponent(expected.branch)}&target_branch=${encodeURIComponent(expected.target)}&per_page=100`, signal)
  if (!Array.isArray(rows) || rows.length > 1) throw new CloudError('交付 MR 查询结果不唯一，需人工核验', 409)
  if (!rows.length) return null
  if (record(rows[0]).state === 'closed') throw new CloudError('代码 MR 已关闭但未合入', 409)
  return validateMR(rows[0], expected)
}
export async function mergedMR(mr: DeliveryMR, signal: AbortSignal, request = gitlabRequest) {
  const row = record(await request(mr.origin, `/projects/${encodeURIComponent(mr.repository)}/merge_requests/${mr.iid}`, signal))
  validateMR(row, mr)
  if (row.state === 'closed') throw new CloudError('MR 已关闭但未合入', 409)
  return row.state === 'merged' && typeof row.merged_at === 'string' && !!(row.merge_commit_sha || row.squash_commit_sha)
}
