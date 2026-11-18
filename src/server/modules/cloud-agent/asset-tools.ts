import path from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import sharp from 'sharp'
import { CloudError } from './domain'
import { scopedPath, sha256 } from './scoped-files'
import { taskTool, textResult } from './task-tools'
import { verifyHarness, type HarnessWorkspace } from './harness'
import { assertHarmonyHead } from './harmony-head'
import { assertSourceApproval } from './harness-domain'

async function imageBytes(file: string) {
  const info = await stat(file)
  if (!info.isFile() || info.size > 12 * 1024 * 1024) throw new CloudError('图片超过 12MiB 或格式非法', 413)
  const bytes = await readFile(file)
  const meta = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata()
  if (!['png', 'jpeg', 'webp'].includes(meta.format || '')) throw new CloudError('只接受 PNG、JPEG、WebP 图片')
  const ext = path.extname(file).toLowerCase()
  if (meta.format === 'png' && ext !== '.png' || meta.format === 'webp' && ext !== '.webp' || meta.format === 'jpeg' && !['.jpg', '.jpeg'].includes(ext)) throw new CloudError('图片扩展名与实际格式不一致')
  return bytes
}
export function assetTools(workspace: HarnessWorkspace, signal: AbortSignal, allowCode: boolean) {
  const string = { type: 'string' }
  const tools = [taskTool('source_image', '读取 Android 范围内真实图片并复制到本任务原型素材目录，不修改业务源码', { path: string }, ['path'], async args => {
    signal.throwIfAborted()
    const file = await scopedPath(workspace.androidRoot, args.path, workspace.androidPrefixes)
    const bytes = await imageBytes(file), hash = sha256(bytes)
    const relative = `candidates/assets/${hash}${path.extname(file).toLowerCase()}`
    const destination = await scopedPath(workspace.artifactRoot, relative, ['candidates'], true)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST' || sha256(await readFile(destination)) !== hash) throw error })
    return textResult({ path: relative, sha256: hash, androidPath: args.path })
  })]
  if (allowCode) tools.push(taskTool('source_image_copy', '将本任务已读取的图片写入整个Harmony项目工作树；需提供目标旧哈希或new，不允许任意二进制', { artifactPath: string, targetPath: string, expectedSha256: string }, ['artifactPath', 'targetPath', 'expectedSha256'], async args => {
    assertSourceApproval((await verifyHarness(workspace, signal, 'ui_prototype_approved')).raw)
    await assertHarmonyHead(workspace, signal)
    if (typeof args.targetPath !== 'string' || !/\.(png|jpe?g|webp)$/.test(args.targetPath)) throw new CloudError('目标必须是Harmony项目内的图片', 403)
    const source = await scopedPath(workspace.artifactRoot, args.artifactPath, ['candidates', 'materials'])
    const bytes = await imageBytes(source)
    if (path.extname(source).toLowerCase() !== path.extname(args.targetPath).toLowerCase()) throw new CloudError('源和目标图片格式必须一致')
    const destination = await scopedPath(workspace.harmonyRoot, args.targetPath, [''], true, true)
    const previous = await readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (args.expectedSha256 !== (previous ? sha256(previous) : 'new')) throw new CloudError('目标资源已变化', 409)
    signal.throwIfAborted()
    await mkdir(path.dirname(destination), { recursive: true })
    await scopedPath(workspace.harmonyRoot, args.targetPath, [''], true, true)
    await writeFile(destination, bytes, { flag: previous ? 'w' : 'wx' })
    return textResult({ path: args.targetPath, sha256: sha256(bytes) })
  }))
  return tools
}
