import { lstat, realpath, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { CloudError } from './domain'
import { inScope } from './git'

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** Accept Windows short/long aliases for the root without resolving untrusted child links. */
export async function relativeToRoot(root: string, file: string) {
  let relative = path.relative(root, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) relative = path.relative(await realpath(root), file)
  if (process.platform === 'win32' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    // Resolve only the root prefix: child junctions must still be rejected by scopedPath.
    const resolvedRoot = await realpath(root)
    const depth = path.relative(path.parse(resolvedRoot).root, resolvedRoot).split(path.sep).length
    const parts = path.relative(path.parse(file).root, file).split(path.sep)
    const prefix = path.join(path.parse(file).root, ...parts.slice(0, depth))
    const resolvedPrefix = await realpath(prefix).catch(() => '')
    if (resolvedPrefix.toLowerCase() === resolvedRoot.toLowerCase()) relative = parts.slice(depth).join(path.sep)
  }
  return relative.replaceAll('\\', '/')
}
export function inProjectScope(file: string, prefixes: string[] = ['']) {
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '..' || part === '.' || /^(?:\.git|git~\d+)(?:\.|$)/i.test(part))) return false
  return prefixes.some(prefix => prefix === '' || file === prefix || file.startsWith(`${prefix}/`))
}
export async function scopedPath(root: string, relative: unknown, prefixes: string[], missing = false, projectFiles = false) {
  if (typeof relative !== 'string' || relative.length > 1000 || /[:\x00-\x1f]/.test(relative) || !(projectFiles ? inProjectScope(relative, prefixes) : inScope(relative, prefixes)) || relative.split('/').some(part => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new CloudError('路径超出任务范围', 403)
  const canonical = await realpath(root)
  let current = canonical
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    const item = await lstat(current).catch(error => { if (missing && error.code === 'ENOENT') return null; throw error })
    if (item?.isSymbolicLink() || (item?.isFile() && item.nlink > 1)) throw new CloudError('任务工具不跟随符号链接、目录联接或硬链接', 403)
  }
  const rel = path.relative(canonical, current)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new CloudError('路径超出任务范围', 403)
  return current
}
export async function readScoped(root: string, relative: unknown, prefixes: string[], offset = 0, projectFiles = false) {
  const file = await scopedPath(root, relative, prefixes, false, projectFiles).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CloudError('文件不存在；请核对该工具根目录下的相对路径', 404)
    throw error
  })
  const info = await lstat(file)
  const maxBytes = (projectFiles ? 16 : 2) * 1024 * 1024
  if (!info.isFile() || info.size > maxBytes) throw new CloudError(`文件不是可读取的文本或超过 ${maxBytes / 1024 / 1024} MiB`, 413)
  const bytes = await readFile(file)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!Number.isSafeInteger(offset) || offset < 0 || text.includes('\0')) throw new CloudError('文本格式或偏移非法')
  return { path: file, relativePath: relative, sha256: sha256(bytes), text: text.slice(offset, offset + 24000), nextOffset: offset + 24000 < text.length ? offset + 24000 : null }
}
export async function inspectCandidate(root: string, relative: unknown) {
  const file = await scopedPath(root, relative, ['candidates'], true)
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return { relativePath: relative, exists: false, expectedSha256: 'new' }
  const current = await readScoped(root, relative, ['candidates'])
  return { relativePath: relative, exists: true, expectedSha256: current.sha256 }
}
export async function writeScoped(root: string, relative: unknown, prefixes: string[], content: unknown, expected: unknown) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 256000 || typeof expected !== 'string') throw new CloudError('写入内容或预期摘要无效')
  if (typeof relative !== 'string' || !/\.(ets|ts|json|json5|xml|md|txt|html|css)$/.test(relative) || /(?:^|\/)(?:hvigorfile|oh-package|build-profile|local\.properties|AGENTS|CLAUDE|opencode)/i.test(relative)) throw new CloudError('不允许改动执行配置或此类型文件', 403)
  const file = await scopedPath(root, relative, prefixes, true)
  const before = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (expected !== (before ? sha256(before) : 'new')) throw new CloudError(before ? '文件已变化，请重新读取后修改；使用 artifact_read/source_read 返回的 sha256，禁止盲目覆盖' : '新建文件 expectedSha256 必须为 new；候选文件可先用 candidate_inspect 确认', 409)
  await mkdir(path.dirname(file), { recursive: true })
  await scopedPath(root, relative, prefixes, true)
  await writeFile(file, content, { flag: before ? 'w' : 'wx', mode: 0o600 })
  return { path: file, sha256: sha256(content) }
}
