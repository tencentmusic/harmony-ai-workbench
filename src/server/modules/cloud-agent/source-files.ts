import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CloudError } from './domain'
import { scopedPath, sha256 } from './scoped-files'

const locks = new Map<string, Promise<void>>()
const maxBytes = 16 * 1024 * 1024
type Mutation = { operation: 'write' | 'edit' | 'delete' | 'move'; path: unknown; expectedSha256: unknown; content?: unknown; edits?: unknown; targetPath?: unknown }

// Serialize mutations per worktree so parallel tools cannot both accept the same old hash.
export async function mutateSource(root: string, args: Mutation) {
  const canonical = await realpath(root), previous = locks.get(canonical) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  locks.set(canonical, current)
  await previous
  try { return await mutate(canonical, args) }
  finally { release(); if (locks.get(canonical) === current) locks.delete(canonical) }
}

async function mutate(root: string, args: Mutation) {
  const file = await scopedPath(root, args.path, [''], true, true)
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (info && (!info.isFile() || info.size > maxBytes)) throw new CloudError('只操作单个文件，文件不得超过16 MiB', 413)
  const before = info ? await readFile(file) : null
  if (args.expectedSha256 !== (before ? sha256(before) : 'new')) throw new CloudError('文件已变化，请 source_read 后使用最新 sha256；新文件使用 new', 409)
  if (args.operation !== 'write' && !before) throw new CloudError('文件不存在，请先核对路径', 404)
  const recheck = async () => {
    await scopedPath(root, args.path, [''], true, true)
    const current = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if ((current ? sha256(current) : 'new') !== args.expectedSha256) throw new CloudError('文件已变化，未覆盖，请重新读取', 409)
  }
  if (args.operation === 'delete') {
    await recheck(); await unlink(file)
    return { path: String(args.path), deleted: true, previousSha256: args.expectedSha256 }
  }
  if (args.operation === 'move') {
    const target = await scopedPath(root, args.targetPath, [''], true, true)
    await mkdir(path.dirname(target), { recursive: true })
    await scopedPath(root, args.targetPath, [''], true, true)
    await recheck()
    await copyFile(file, target, constants.COPYFILE_EXCL).catch(error => {
      if (error.code === 'EEXIST') throw new CloudError('目标已存在，未覆盖，请选择新路径', 409)
      throw error
    })
    try { await recheck(); await unlink(file) }
    catch (error) { await unlink(target); throw error }
    return { path: String(args.targetPath), movedFrom: String(args.path), sha256: sha256(before!) }
  }
  let content: unknown = args.content
  if (args.operation === 'edit') {
    if (!Array.isArray(args.edits) || !args.edits.length) throw new CloudError('请提供非空 edits 原文替换列表')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before!) }
    catch { throw new CloudError('局部编辑仅支持 UTF-8 文本') }
    if (text.includes('\0')) throw new CloudError('局部编辑仅支持 UTF-8 文本')
    for (const value of args.edits as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudError('每项需要非空原文 oldText 和替换文本 newText')
      const item = value as Record<string, unknown>
      if (typeof item.oldText !== 'string' || !item.oldText || typeof item.newText !== 'string') throw new CloudError('每项需要非空原文 oldText 和替换文本 newText')
      const index = text.indexOf(item.oldText)
      if (index < 0) throw new CloudError('原文未匹配，整批未写入；请重读对应片段', 409)
      if (text.indexOf(item.oldText, index + 1) >= 0) throw new CloudError('原文不是唯一匹配，整批未写入；请增加上下文', 409)
      if (Buffer.byteLength(text) - Buffer.byteLength(item.oldText) + Buffer.byteLength(item.newText) > maxBytes) throw new CloudError('替换结果超过16 MiB，整批未写入', 413)
      text = text.slice(0, index) + item.newText + text.slice(index + item.oldText.length)
    }
    content = text
  }
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > maxBytes) throw new CloudError('写入内容必须为16 MiB以内文本；大文件优先使用 source_edit 局部替换', 413)
  await mkdir(path.dirname(file), { recursive: true })
  await recheck()
  if (!before) await writeFile(file, content, { flag: 'wx', mode: 0o600 })
  else {
    const temp = path.join(path.dirname(file), `.cloud-edit-${randomUUID()}.tmp`)
    await writeFile(temp, content, { flag: 'wx', mode: info!.mode })
    try { await recheck(); await rename(temp, file) }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  return { path: String(args.path), sha256: sha256(content) }
}
