import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CloudAttachment } from '@/contracts/cloud-agent'
import { CloudError } from './domain'
import { materialDirectory } from './materials'
import { mediaTool, prepareMaterial, type PreparedMaterial } from './material-processing'
import { taskTool, textResult } from './task-tools'

export async function materialTools(attachments: CloudAttachment[], signal: AbortSignal, outputRoot: string) {
  let deliveredBytes = 0, frameCount = 0
  const configured = Number(process.env.CLOUD_AGENT_VIDEO_FRAME_BUDGET)
  const frameBudget = Number.isSafeInteger(configured) && configured > 0 ? Math.min(600, configured) : 120
  const metadata = new Map<string, PreparedMaterial>()
  const catalog = attachments.map(file => ({ ...file, path: path.join(materialDirectory(file.id), 'original') }))
  async function resolve(value: unknown) {
    const file = catalog.find(item => item.id === value)
    if (!file) throw new CloudError('附件不属于本轮材料快照', 403)
    let prepared = metadata.get(file.id)
    if (!prepared) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file.path, { signal })) hash.update(chunk as Buffer)
      if (hash.digest('hex') !== file.sha256) throw new CloudError('附件完整性校验失败', 422)
      // Rebuild legacy prepared metadata so old six-frame caches never dictate analysis.
      prepared = await prepareMaterial(materialDirectory(file.id), file.name, signal)
      metadata.set(file.id, prepared)
    }
    return { file, prepared }
  }
  const id = { type: 'string', description: '材料清单中的附件 id，不接受任意路径' }
  return { catalog, tools: [
    taskTool('materials', '列出本轮材料原件及读取路径；内容按需读取，不自动展开', {}, [], async () => textResult({ materials: catalog, frameBudget, batchLimit: 8, audioTranscription: false })),
    taskTool('read_material', '读取文档片段、图片或 PDF；视频返回时长和尺寸，由你按 Harness 状态覆盖规则决定抽帧', { id, offset: { type: 'integer', minimum: 0 } }, ['id'], async args => {
      const { file, prepared } = await resolve(args.id)
      const offset = args.offset === undefined ? 0 : Number(args.offset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CloudError('文档偏移非法')
      let artifact: { path: string; sha256: string } | undefined
      if (file.kind === 'image') {
        const folder = path.join(outputRoot, 'originals')
        await mkdir(folder, { recursive: true, mode: 0o700 })
        const destination = path.join(folder, `${file.id}${path.extname(file.name).toLowerCase()}`)
        const bytes = await readFile(file.path)
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new CloudError('附件完整性校验失败', 422)
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }).catch(async error => {
          if (error.code !== 'EEXIST' || createHash('sha256').update(await readFile(destination)).digest('hex') !== file.sha256) throw error
        })
        artifact = { path: destination, sha256: file.sha256 }
      }
      const content = textResult({ name: file.name, sha256: file.sha256, path: file.path, artifact, video: prepared.video,
        text: prepared.text.slice(offset, offset + 16000), nextOffset: offset + 16000 < prepared.text.length ? offset + 16000 : null, warnings: prepared.warnings }).content
      if (!prepared.video) for (const part of prepared.files) {
        const bytes = await readFile(path.join(materialDirectory(file.id), part.name))
        if (deliveredBytes + bytes.length > 64 * 1024 * 1024) throw new CloudError('本轮材料读取达到 64 MiB 预算，请分轮继续', 413)
        deliveredBytes += bytes.length
        if (part.mime.startsWith('image/')) content.push({ type: 'image', data: bytes.toString('base64'), mimeType: part.mime })
        else content.push({ type: 'resource', resource: { uri: pathToFileURL(file.path).href, mimeType: part.mime, blob: bytes.toString('base64') } })
      }
      return { content }
    }),
    taskTool('video_frames', '按自己选择的时间点抽帧/补帧，每批至多8张。先观察再按页面、状态变化补充；预算不是覆盖完成标志',
      { id, timestamps: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 8 }, reason: { type: 'string', maxLength: 1000 } }, ['id', 'timestamps', 'reason'], async args => {
        const { file, prepared } = await resolve(args.id)
        if (!prepared.video) throw new CloudError('该附件不是视频')
        const times = args.timestamps
        if (!Array.isArray(times) || !times.length || times.length > 8 || times.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time >= prepared.video!.duration) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000) throw new CloudError('抽帧时间点或理由无效')
        if (frameCount + times.length > frameBudget) throw new CloudError(`本轮抽帧达到安全预算 ${frameBudget}；记录未覆盖片段，不可声称已完整分析`, 413)
        const content = textResult({ source: file.path, sha256: file.sha256, timestamps: times, reason: args.reason }).content
        const folder = path.join(outputRoot, 'frames', file.id)
        await mkdir(folder, { recursive: true, mode: 0o700 })
        for (const time of times as number[]) {
          signal.throwIfAborted()
          frameCount++
          const destination = path.join(folder, `${time.toFixed(3)}-${frameCount}.jpg`)
          await mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-threads', '1', '-ss', String(time), '-i', file.path, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-threads', '1', '-q:v', '3', '-y', destination], signal)
          const bytes = await readFile(destination)
          if (deliveredBytes + bytes.length > 64 * 1024 * 1024) throw new CloudError('本轮材料读取达到 64 MiB 预算', 413)
          deliveredBytes += bytes.length
          const receipt = { source: file.path, sourceSha256: file.sha256, timestamp: time, path: destination, sha256: createHash('sha256').update(bytes).digest('hex'), reason: args.reason }
          await writeFile(`${destination}.json`, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
          content.push({ type: 'text', text: JSON.stringify(receipt) }, { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') })
        }
        return { content }
      }),
  ] }
}
