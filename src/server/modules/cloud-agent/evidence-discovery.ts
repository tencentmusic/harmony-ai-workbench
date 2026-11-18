import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { CloudError } from './domain'
import { scopedPath, sha256 } from './scoped-files'
import { taskTool, textResult } from './task-tools'

export async function listArtifacts(root: string, directory: unknown = '', offset: unknown = 0) {
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new CloudError('目录偏移非法')
  const resolved = directory === '' ? await realpath(root) : await scopedPath(root, directory, [''])
  const rows = (await readdir(resolved, { withFileTypes: true }))
    .filter(e => !e.name.startsWith('.') && !e.isSymbolicLink() && (e.isFile() || e.isDirectory()))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { entries: rows.slice(Number(offset), Number(offset) + 100).map(e => ({ path: directory ? `${directory}/${e.name}` : e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    nextOffset: Number(offset) + 100 < rows.length ? Number(offset) + 100 : null }
}

// Standard parsers inspect members in memory only; never extract or execute archive contents.
const archiveReader = `import json,sys,tarfile,zipfile,stat
file,entry=sys.argv[1:3]
def safe(name):
    return bool(name) and not name.startswith('/') and not any(x in name for x in ['\\\\', ':', '\\x00']) and all(p not in ['', '.', '..'] for p in name.split('/'))
if zipfile.is_zipfile(file):
    archive=zipfile.ZipFile(file)
    members=archive.infolist()
    assert len(members)<=10000, 'too many members'
    items={m.filename:m for m in members if not m.is_dir() and not stat.S_ISLNK(m.external_attr>>16) and safe(m.filename)}
    assert len({m.filename for m in members})==len(members), 'duplicate members'
    size=lambda m:m.file_size
    stream=lambda m:archive.open(m)
else:
    archive=tarfile.open(file,'r:*')
    items={}
    count=0
    for m in archive:
        count+=1
        assert count<=10000, 'too many members'
        if m.isfile() and safe(m.name):
            assert m.name not in items, 'duplicate members'
            items[m.name]=m
    size=lambda m:m.size
    stream=lambda m:archive.extractfile(m)
if not entry:
    print(json.dumps({'entries':sorted(items)},ensure_ascii=False))
else:
    assert safe(entry) and entry in items, 'member missing or unsafe'
    member=items[entry]
    assert size(member)<=2097152, 'member exceeds 2 MiB'
    with stream(member) as source: data=source.read(2097153)
    assert len(data)<=2097152, 'member exceeds 2 MiB'
    text=data.decode('utf-8-sig')
    assert '\\x00' not in text, 'binary member'
    print(json.dumps({'text':text},ensure_ascii=False))
archive.close()
`

export async function readSourceArchive(root: string, archivePath: unknown, entry: unknown, offset: unknown, signal: AbortSignal) {
  if (typeof archivePath !== 'string' || !/\.har$/i.test(archivePath)) throw new CloudError('仅支持任务工作树中的 HAR 包')
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new CloudError('归档偏移非法')
  if (entry !== undefined && (typeof entry !== 'string' || !/\.(?:ets|ts|js|json5?|md|txt|h|hpp)$/i.test(entry) || /[:\\\x00-\x1f]/.test(entry) || entry.split('/').some(p => !p || p === '.' || p === '..'))) throw new CloudError('仅能读取安全的归档文本成员')
  const file = await scopedPath(root, archivePath, [''], false, true)
  const info = await lstat(file)
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new CloudError('HAR 包超过128 MiB或不是文件', 413)
  const archiveSha256 = sha256(await readFile(file))
  let output: string
  try {
    output = (await promisify(execFile)(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', archiveReader, file, String(entry || '')],
      { signal, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024, env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })).stdout
  } catch { signal.throwIfAborted(); throw new CloudError('HAR 读取失败：请核对成员路径、文本格式、大小或Python环境；先不带entry列举目录，不猜路径', 409) }
  if (sha256(await readFile(file)) !== archiveSha256) throw new CloudError('读取期间HAR已变化，请重新读取', 409)
  const parsed = JSON.parse(output) as { entries?: string[]; text?: string }
  const start = Number(offset)
  return { archivePath, archiveSha256, entry, text: parsed.text?.slice(start, start + 24000),
    entries: parsed.entries?.slice(start, start + 100), nextOffset: parsed.entries ? start + 100 < parsed.entries.length ? start + 100 : null : start + 24000 < (parsed.text?.length || 0) ? start + 24000 : null,
    evidenceScope: 'HAR text/declarations only; not proof of binary behavior, signing or device acceptance' }
}

export function evidenceDiscoveryTools(artifactRoot: string, harmonyRoot: string, signal: AbortSignal) {
  return [
    taskTool('artifact_list', '列举任务产物单层目录，返回可直接用于artifact_read的相对路径；路径读错先列举，不递归扫描；空directory从根开始', { directory: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [], async args => textResult(await listArtifacts(artifactRoot, args.directory ?? '', args.offset ?? 0))),
    taskTool('source_archive', '只读Harmony任务工程中的HAR。不填entry列举成员；按返回entry分段读接口/源码文本，offset沿nextOffset。不可执行或解压，不把声明当二进制运行证明', { path: { type: 'string' }, entry: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, ['path'], async args => textResult(await readSourceArchive(harmonyRoot, args.path, args.entry, args.offset ?? 0, signal))),
  ]
}
