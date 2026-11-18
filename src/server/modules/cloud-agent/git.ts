import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, access, rmdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { CloudError, CloudTransientError, validBranch } from './domain'
import { branchAllowed, cloudProject, cloudProjects } from './config'
import { requireApp, type CloudActor } from './http'

const execute = promisify(execFile)
export const cloudRoot = () => path.resolve(process.env.CLOUD_AGENT_RUNTIME_ROOT || '.runtime/cloud-agent')
export async function repositoryIssue(root: string): Promise<string | null> {
  try {
    if (!(await stat(root)).isDirectory()) return '配置的源码路径不是目录，请修正项目配置'
    if (!(await readdir(root)).length) return '配置的源码目录为空，可能被清理或尚未拉取；请恢复仓库或修正项目路径'
    const entry = await stat(path.join(root, '.git')).catch(() => null)
    const prefix = await git(root, ['rev-parse', '--show-prefix'])
    if (!entry) {
      const top = await git(root, ['rev-parse', '--show-toplevel'])
      const tracked = prefix && await git(top, ['ls-tree', '-d', '--name-only', 'HEAD', '--', `:(literal)${prefix.replace(/\/$/, '')}`])
      if (!tracked) return '配置的源码目录不是 Git 仓库中的已跟踪目录，请恢复仓库或修正项目路径'
    }
    return null
  } catch (error) {
    if (error instanceof CloudError) return error.message
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '配置的源码目录不存在，请恢复仓库或修正项目路径' : '源码目录无法读取，请检查执行机的文件访问权限'
  }
}
export async function listCloudApps(actor: CloudActor) {
  return Promise.all(cloudProjects().filter(app => actor.appIds.includes(app.id)).map(async app => {
    const [android, harmony] = await Promise.all([repositoryIssue(app.androidRoot), repositoryIssue(app.harmonyRoot)])
    return { id: app.id, label: app.label, defaultBranch: app.defaultBranch, model: app.model,
      sourceIssues: [android ? `Android：${android}` : '', harmony ? `鸿蒙：${harmony}` : ''].filter(Boolean) }
  }))
}
export function gitFailureReason(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { stderr?: unknown; code?: unknown; killed?: boolean; signal?: unknown } : {}
  const stderr = typeof value.stderr === 'string' ? value.stderr : ''
  if (value.code === 'ENOENT') return '执行机未找到 Git，请检查安装与 PATH'
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git 输出超过安全上限，请缩小查询范围'
  if (value.killed || value.code === 'ETIMEDOUT') return 'Git 操作超时，请检查网络或仓库大小后重试'
  if (/filename too long|file name too long/i.test(stderr)) return '源码路径过长，请启用 Git 长路径或缩短运行目录'
  if (/not a git repository|cannot change to/i.test(stderr)) return '源码目录不是 Git 仓库或已缺失，请恢复仓库或修正项目路径'
  if (/no such remote|no remote configured/i.test(stderr)) return '仓库未配置 origin，请由管理员补齐远程地址'
  if (/couldn.t find remote ref|not our ref|unadvertised object/i.test(stderr)) return '远程分支或提交不存在，请重新选择分支或核对 MR 基线'
  if (/authentication failed|could not read username|permission denied \(publickey\)|terminal prompts disabled|interactivity has been disabled|(?:returned error:|http(?:\/\S+)?\s+|status(?: code)?[:=]?\s+)\s*(?:401|403)\b/i.test(stderr)) return '仓库认证失败，请配置执行机的 Git 凭据或 SSH 授权'
  if (/could not resolve|failed to connect|connection (?:refused|reset|timed out)|unable to access|ssl certificate/i.test(stderr)) return '仓库网络连接失败，请检查网络、代理和证书'
  if (/repository not found|could not read from remote repository/i.test(stderr)) return '远程仓库访问失败，请核对 origin 地址及仓库授权'
  if (/dubious ownership/i.test(stderr)) return 'Git 拒绝仓库所有者，请由管理员核对目录归属与信任配置'
  return 'Git 执行失败，请由管理员检查仓库状态后重试'
}
export async function git(root: string, args: string[], signal?: AbortSignal, overrides: Record<string, string> = {}, includeMessages = false) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SSH_AUTH_SOCK', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, overrides)
  try {
    const output = await execute('git', ['-C', root, '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args],
      { env, timeout: args[0] === 'worktree' ? 600_000 : 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal })
    return (includeMessages ? `${output.stdout}\n${output.stderr}` : output.stdout).trimEnd()
  } catch (error) {
    signal?.throwIfAborted()
    const operations: Record<string, string> = { remote: '读取仓库地址', 'ls-remote': '查询远程分支', init: '初始化分析缓存', fetch: '拉取源码基线', 'rev-parse': '核验提交', 'ls-tree': '读取源码目录', 'cat-file': '读取源码文件' }
    const failure = error as { code?: string; stderr?: string; killed?: boolean }
    const transient = ['fetch', 'push', 'ls-remote'].includes(args[0]) && (failure.code === 'ETIMEDOUT' || failure.killed || /could not resolve|failed to connect|connection (?:refused|reset|timed out)/i.test(failure.stderr || ''))
    throw new (transient ? CloudTransientError : CloudError)(`${operations[args[0]] || 'Git 操作'}失败：${gitFailureReason(error)}`, 503)
  }
}
export async function repositoryIdentity(root: string) {
  const issue = await repositoryIssue(root)
  if (issue) throw new CloudError(issue, 503)
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  const ssh = /^git@([^:]+):(.+)$/.exec(remote)
  let url: URL
  try { url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote) } catch { throw new CloudError('仓库 origin 必须是受管 Git 地址', 503) }
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || url.password || (url.protocol !== 'ssh:' && url.username)) throw new CloudError('仓库 origin 不支持此协议或内嵌凭据', 503)
  const origin = `https://${url.host}`
  const sourcePrefix = await git(root, ['rev-parse', '--show-prefix'])
  return { remote, origin, repository: url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''), sourcePrefix }
}
export async function listCloudBranches(actor: CloudActor, appId: string) {
  requireApp(actor, appId)
  const project = cloudProject(appId)
  const issue = await repositoryIssue(project.harmonyRoot)
  if (issue) throw new CloudError(`${project.label}鸿蒙源码：${issue}`, 503)
  const output = await git(project.harmonyRoot, ['ls-remote', '--heads', 'origin', ...project.branchPatterns.map(pattern => `refs/heads/${pattern}`)])
  return output.split('\n').flatMap(line => {
    const match = /^[a-f0-9]{40,64}\s+refs\/heads\/(.+)$/.exec(line)
    return match && branchAllowed(project, match[1]) ? [match[1]] : []
  }).sort()
}
export async function freezeBranch(root: string, branch: string, signal?: AbortSignal, expectedSha?: string) {
  if (!validBranch(branch) || (expectedSha && !/^[a-f0-9]{40,64}$/.test(expectedSha))) throw new CloudError('分支或提交非法')
  const identity = await repositoryIdentity(root)
  const key = createHash('sha256').update(identity.remote).digest('hex')
  const parent = path.join(cloudRoot(), 'repositories')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const cache = path.join(parent, `${key}.git`)
  const lock = path.join(parent, `${key}.lock`)
  let acquired = false
  for (let i = 0; i < 120; i++) {
    signal?.throwIfAborted()
    try { await mkdir(lock); acquired = true; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!acquired) throw new CloudError('Git 缓存正在使用或需恢复，稍后重试', 503)
  try {
    await mkdir(cache, { recursive: true, mode: 0o700 })
    try { await access(path.join(cache, 'HEAD')) } catch { await git(cache, ['init', '--bare'], signal) }
    const ref = expectedSha ? `refs/cloud/snapshots/${expectedSha}` : `refs/remotes/source/${branch}`
    await git(cache, ['fetch', '--no-tags', '--depth=1', identity.remote, `${expectedSha || `refs/heads/${branch}`}:${ref}`], signal)
    const sha = await git(cache, ['rev-parse', '--verify', `${ref}^{commit}`], signal)
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('无法固定源码提交', 503)
    if (expectedSha && sha !== expectedSha) throw new CloudError('MR 合入提交与拉取版本不一致', 503)
    return { cache, sha, identity }
  } finally { await rmdir(lock) }
}
export function inScope(file: string, prefixes: string[]) {
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) return false
  return prefixes.length > 0 && prefixes.some(prefix => prefix === '' || file === prefix || file.startsWith(`${prefix}/`))
}
export function sourcePrefixes(prefixes: string[], suffix: string) {
  if (!suffix) return prefixes
  return prefixes.flatMap(prefix => prefix === '' || prefix === suffix || suffix.startsWith(`${prefix}/`) ? [''] : prefix.startsWith(`${suffix}/`) ? [prefix.slice(suffix.length + 1)] : [])
}
export function sourceRelativePath(file: string, sourcePrefix = ''): string | null {
  return sourcePrefix ? file.startsWith(sourcePrefix) ? file.slice(sourcePrefix.length) : null : file
}
export async function collectCode(snapshot: { cache: string; sha: string; identity?: { sourcePrefix: string } }, prefixes: string[], material: string, signal?: AbortSignal) {
  const names = [...new Set(material.match(/\b[A-Z][A-Za-z0-9_]{5,}(?:\.(?:java|kt|ets|ts))?\b/g) || [])].slice(0, 12)
  if (!names.length || !prefixes.length) return []
  const sourcePrefix = snapshot.identity?.sourcePrefix || ''
  const tree = await git(snapshot.cache, ['ls-tree', '-r', '-l', '-z', snapshot.sha, '--', ...prefixes.map(prefix => sourcePrefix || prefix ? `:(literal)${sourcePrefix}${prefix}` : '.')], signal)
  const candidates = tree.split('\0').flatMap(line => {
    const match = /^100644 blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line)
    const relative = match ? sourceRelativePath(match[3], sourcePrefix) : null
    return match && relative && Number(match[2]) < 100_000 && inScope(relative, prefixes) && names.some(name => path.posix.basename(relative).split('.')[0] === name.split('.')[0]) ? [{ oid: match[1], file: match[3] }] : []
  }).slice(0, 6)
  const results: string[] = []
  for (const candidate of candidates) results.push(`${candidate.file} @ ${snapshot.sha}\n${(await git(snapshot.cache, ['cat-file', 'blob', candidate.oid], signal)).slice(0, 12000)}`)
  return results
}
