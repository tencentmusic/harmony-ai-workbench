import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, writeFile, mkdir, unlink, copyFile, utimes } from 'node:fs/promises'
import { constants } from 'node:fs'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { CloudError, record } from './domain'
import { scopedPath, sha256 } from './scoped-files'

export interface ArtifactStorageInput {
  artifactRoot: string; archiveRoot: string; identity: string; context: string; minimumAgeMs: number
}
interface FileRow { path: string; size: number; mtime: number; hash?: string }
interface ArchiveSource { kind: 'retained' | 'gzip'; path: string }
interface ArchiveEntry extends FileRow { sha256: string; source: ArchiveSource }
interface ArchiveManifest { version: 1; identity: string; artifactRoot: string; createdAt: string; planDigest: string; entries: ArchiveEntry[] }
const backupPattern = /^execution\/(build-[A-Za-z0-9_-]+)\/previous-\d+\.hsp$/
const retainedPattern = /^execution\/build-[A-Za-z0-9_-]+\/dependency-\d+\.hsp$/
const metadataPattern = /\.(json|jsonl|json5|md|txt|html|log|mjs)$/i
const maximumFileBytes = 512 * 1024 * 1024
const compress = promisify(gzip), decompress = promisify(gunzip)
const normalized = (value: string) => value.replace(/\\+/g, '/').toLowerCase()

async function roots(input: ArtifactStorageInput) {
  if (!input.identity || !Number.isSafeInteger(input.minimumAgeMs) || input.minimumAgeMs < 0 ||
    !path.isAbsolute(input.artifactRoot) || !path.isAbsolute(input.archiveRoot) ||
    path.dirname(path.resolve(input.archiveRoot)) !== path.dirname(path.resolve(input.artifactRoot)) ||
    path.basename(input.archiveRoot) !== 'artifact-archive' || path.basename(input.artifactRoot) !== 'artifacts') throw new CloudError('产物归档根目录或保留期限非法', 409)
  for (const file of [input.artifactRoot, path.dirname(input.artifactRoot), input.archiveRoot]) {
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' && file === input.archiveRoot) return null; throw error })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new CloudError('产物归档不接受链接目录', 409)
  }
}

async function inventory(root: string, signal?: AbortSignal) {
  const files: FileRow[] = [], pending = ['']
  let directories = 0
  while (pending.length) {
    const directory = pending.pop()!
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      signal?.throwIfAborted()
      const relative = [directory, item.name].filter(Boolean).join('/')
      if (item.isSymbolicLink()) throw new CloudError(`产物目录包含链接，未清理：${relative}`, 409)
      const file = await scopedPath(root, relative, [''], false, true), stat = await lstat(file)
      if (stat.isDirectory()) { pending.push(relative); directories++ }
      else if (stat.isFile()) files.push({ path: relative, size: stat.size, mtime: stat.mtimeMs })
      else throw new CloudError(`产物包含非普通文件，未清理：${relative}`, 409)
      if (files.length + directories > 30000) throw new CloudError('产物数量超过安全扫描上限，未清理', 409)
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function referenced(value: unknown, candidates: FileRow[], pinned: Set<string>) {
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      const text = normalized(item)
      for (const candidate of candidates) {
        if (text.includes(normalized(candidate.path)) || text.includes(path.basename(candidate.path).toLowerCase())) pinned.add(candidate.path)
      }
      // Database snapshots sometimes contain another JSON document as a string.
      if (/^\s*[\[{]/.test(item)) { try { pending.push(JSON.parse(item)) } catch { /* Plain text is already conservatively scanned. */ } }
    } else if (Array.isArray(item)) pending.push(...item)
    else if (item && typeof item === 'object') pending.push(...Object.keys(item), ...Object.values(item))
  }
}

export async function previewArtifactStorage(input: ArtifactStorageInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await roots(input)
  const files = await inventory(input.artifactRoot, signal)
  const backups = files.filter(file => backupPattern.test(file.path)), pinned = new Set<string>()
  const terminal = new Map<string, string>()
  let metadataBytes = 0
  referenced(input.context, backups, pinned)
  for (const file of files) {
    signal?.throwIfAborted()
    if (!metadataPattern.test(file.path)) continue
    metadataBytes += file.size
    if (file.size > 64 * 1024 * 1024 || metadataBytes > maximumFileBytes) throw new CloudError('产物元数据超限，不能证明无引用，未清理', 409)
    const bytes = await readFile(await scopedPath(input.artifactRoot, file.path, [''], false, true))
    file.hash = sha256(bytes)
    const text = bytes.toString('utf8')
    if (/\.jsonl?$/i.test(file.path)) {
      let values: unknown[]
      try { values = file.path.endsWith('.jsonl') ? text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : [JSON.parse(text)] }
      catch { throw new CloudError(`产物元数据无法解析，未清理：${file.path}`, 409) }
      for (const value of values) {
        referenced(value, backups, pinned)
        if (file.path === 'harness/harness-events.jsonl') {
          const event = record(value)
          if (event.command === 'run-build' && typeof event.operation_id === 'string') terminal.set(event.operation_id, String(event.status))
        }
      }
    } else referenced(text, backups, pinned)
  }
  const candidates: (FileRow & { sha256: string; reason: string; source: ArchiveSource })[] = []
  const anchors = new Map<string, string>()
  for (const file of files.filter(file => retainedPattern.test(file.path))) {
    signal?.throwIfAborted()
    if (file.size > maximumFileBytes) continue
    file.hash = sha256(await readFile(await scopedPath(input.artifactRoot, file.path, [''], false, true)))
    if (!anchors.has(file.hash)) anchors.set(file.hash, file.path)
  }
  for (const file of backups) {
    signal?.throwIfAborted()
    const build = backupPattern.exec(file.path)![1]
    if (pinned.has(file.path) || Date.now() - file.mtime < input.minimumAgeMs ||
      !['committed', 'failed', 'rolled_back'].includes(terminal.get(build) || '') || file.size > maximumFileBytes) continue
    file.hash = sha256(await readFile(await scopedPath(input.artifactRoot, file.path, [''], false, true)))
    const anchor = anchors.get(file.hash)
    candidates.push({ ...file, sha256: file.hash, reason: 'settled_unreferenced_build_backup',
      source: anchor ? { kind: 'retained', path: anchor } : { kind: 'gzip', path: `objects/${file.hash}.gz` } })
  }
  const digest = sha256(JSON.stringify({ version: 1, identity: input.identity, root: path.resolve(input.artifactRoot), context: sha256(input.context), minimumAgeMs: input.minimumAgeMs, files, candidates }))
  const byDirectory = new Map<string, { files: number; bytes: number }>()
  for (const file of files) {
    const group = file.path.split('/')[0], total = byDirectory.get(group) || { files: 0, bytes: 0 }
    total.files++; total.bytes += file.size; byDirectory.set(group, total)
  }
  return { identity: input.identity, digest, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
    directories: Object.fromEntries(byDirectory), protectedBackupCount: backups.length - candidates.length, candidates,
    candidateBytes: candidates.reduce((sum, file) => sum + file.size, 0), duplicateBytes: candidates.filter(file => file.source.kind === 'retained').reduce((sum, file) => sum + file.size, 0) }
}

async function recoveryBytes(input: ArtifactStorageInput, entry: ArchiveEntry) {
  let bytes: Buffer
  if (entry.source.kind === 'retained') bytes = await readFile(await scopedPath(input.artifactRoot, entry.source.path, [''], false, true))
  else {
    const file = await scopedPath(input.archiveRoot, entry.source.path, ['objects'])
    if ((await lstat(file)).size > maximumFileBytes) throw new CloudError('归档对象超限', 409)
    bytes = await decompress(await readFile(file), { maxOutputLength: entry.size + 1 })
  }
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new CloudError('归档恢复源摘要不匹配，未操作原件', 409)
  return bytes
}

export async function archiveArtifactStorage(input: ArtifactStorageInput, expectedDigest: string, signal: AbortSignal, beforeMutation = async () => {}) {
  signal.throwIfAborted()
  const plan = await previewArtifactStorage(input, signal)
  if (plan.digest !== expectedDigest) throw new CloudError('产物或任务已变化，请重新预览；未清理', 409)
  if (!plan.candidates.length) return { archiveId: null, files: 0, archivedBytes: 0, reclaimedBytes: 0 }
  await beforeMutation(); signal.throwIfAborted()
  await mkdir(input.archiveRoot, { recursive: true, mode: 0o700 })
  await roots(input)
  const objectRoot = await scopedPath(input.archiveRoot, 'objects', ['objects'], true)
  await mkdir(objectRoot, { recursive: true, mode: 0o700 })
  const entries: ArchiveEntry[] = [], createdObjects: string[] = []
  let storedBytes = 0
  for (const candidate of plan.candidates) {
    signal.throwIfAborted()
    const entry: ArchiveEntry = { path: candidate.path, size: candidate.size, mtime: candidate.mtime, sha256: candidate.sha256, source: candidate.source }
    if (entry.source.kind === 'gzip') {
      const original = await readFile(await scopedPath(input.artifactRoot, entry.path, [''], false, true))
      if (sha256(original) !== entry.sha256) throw new CloudError('归档源已变化，未清理', 409)
      const destination = await scopedPath(input.archiveRoot, entry.source.path, ['objects'], true)
      const exists = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (!exists) {
        const compressed = await compress(original)
        await writeFile(destination, compressed, { flag: 'wx', mode: 0o600 })
        createdObjects.push(entry.source.path); storedBytes += compressed.length
      }
    }
    await recoveryBytes(input, entry)
    entries.push(entry)
  }
  // Publication precedes removal. A crash after any unlink still leaves a complete recovery manifest.
  await beforeMutation(); signal.throwIfAborted()
  const rechecked = await previewArtifactStorage(input, signal)
  if (rechecked.digest !== plan.digest) throw new CloudError('归档准备期间产物已变化，未清理', 409)
  const archiveId = randomUUID()
  const manifest: ArchiveManifest = { version: 1, identity: input.identity, artifactRoot: path.resolve(input.artifactRoot), createdAt: new Date().toISOString(), planDigest: plan.digest, entries }
  const text = JSON.stringify(manifest, null, 2)
  await writeFile(await scopedPath(input.archiveRoot, `${archiveId}.json`, [''], true), text, { flag: 'wx', mode: 0o600 })
  let removedBytes = 0
  for (const entry of entries) {
    await beforeMutation(); signal.throwIfAborted()
    const file = await scopedPath(input.artifactRoot, entry.path, [''], false, true)
    if (sha256(await readFile(file)) !== entry.sha256) throw new CloudError(`归档源已变化；已处理部分可用 ${archiveId} 恢复`, 409)
    await recoveryBytes(input, entry)
    await unlink(file)
    removedBytes += entry.size
  }
  return { archiveId, files: entries.length, archivedBytes: removedBytes, reclaimedBytes: removedBytes - storedBytes - Buffer.byteLength(text), createdObjects }
}

async function readManifest(input: ArtifactStorageInput, id: string): Promise<ArchiveManifest> {
  await roots(input)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new CloudError('归档编号非法', 409)
  const file = await scopedPath(input.archiveRoot, `${id}.json`, [''])
  if ((await lstat(file)).size > 4 * 1024 * 1024) throw new CloudError('归档索引超限', 409)
  const value = record(JSON.parse(await readFile(file, 'utf8')))
  if (value.version !== 1 || value.identity !== input.identity || value.artifactRoot !== path.resolve(input.artifactRoot) || !Array.isArray(value.entries)) throw new CloudError('归档身份不匹配', 409)
  const paths = new Set<string>()
  for (const item of value.entries) {
    const entry = record(item), source = record(entry.source)
    if (typeof entry.path !== 'string' || !backupPattern.test(entry.path) || paths.has(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > maximumFileBytes || typeof entry.mtime !== 'number' || !Number.isFinite(entry.mtime) || entry.mtime < 0 ||
      !(source.kind === 'retained' && typeof source.path === 'string' && retainedPattern.test(source.path) || source.kind === 'gzip' && source.path === `objects/${entry.sha256}.gz`)) throw new CloudError('归档路径或条目非法', 409)
    paths.add(entry.path)
  }
  return value as unknown as ArchiveManifest
}

export async function listArtifactArchives(input: ArtifactStorageInput) {
  await roots(input)
  const names = await readdir(input.archiveRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const result = []
  for (const name of names.filter(value => value.endsWith('.json')).sort()) {
    const id = name.slice(0, -5), manifest = await readManifest(input, id)
    result.push({ id, createdAt: manifest.createdAt, files: manifest.entries.length, bytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0) })
  }
  return result
}

export async function restoreArtifactStorage(input: ArtifactStorageInput, archiveId: string, signal: AbortSignal, beforeMutation = async () => {}) {
  signal.throwIfAborted()
  const manifest = await readManifest(input, archiveId)
  // Validate every destination and source before restoring the first file.
  for (const entry of manifest.entries) {
    signal.throwIfAborted()
    const destination = await scopedPath(input.artifactRoot, entry.path, [''], true, true)
    const current = await readFile(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (current && sha256(current) !== entry.sha256) throw new CloudError('原路径已有不同内容，拒绝覆盖', 409)
    await recoveryBytes(input, entry)
  }
  let restored = 0
  for (const entry of manifest.entries) {
    await beforeMutation(); signal.throwIfAborted()
    const destination = await scopedPath(input.artifactRoot, entry.path, [''], true, true)
    const current = await readFile(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (current) { if (sha256(current) !== entry.sha256) throw new CloudError('原路径已有不同内容，拒绝覆盖', 409); continue }
    const bytes = await recoveryBytes(input, entry)
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = await scopedPath(input.archiveRoot, `restore-${randomUUID()}.tmp`, [''], true)
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try {
      await scopedPath(input.artifactRoot, entry.path, [''], true, true)
      await copyFile(temporary, destination, constants.COPYFILE_EXCL)
      await utimes(destination, new Date(entry.mtime), new Date(entry.mtime))
      restored++
    } finally { await unlink(temporary) }
  }
  return { archiveId, restored, files: manifest.entries.length }
}
