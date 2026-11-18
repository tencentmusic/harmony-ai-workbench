import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CloudError, record } from './domain'
import { mediaTool } from './material-processing'
import { sha256 } from './scoped-files'
import { textResult } from './task-tools'

export async function previewDeviceVideo(root: string, file: string, expectedHash: unknown, timestamps: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new CloudError('观察视频缺少有效摘要')
  if ((await stat(file)).size > 256 * 1024 * 1024) throw new CloudError('观察视频超过 256 MiB 上限', 413)
  const verify = async () => {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file, { signal })) digest.update(chunk as Buffer)
    if (digest.digest('hex') !== expectedHash) throw new CloudError('观察视频摘要已变化', 409)
  }
  await verify()
  const { stdout } = await mediaTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height', '-of', 'json', file], signal)
  const info = record(JSON.parse(stdout)), format = record(info.format || {})
  const stream = Array.isArray(info.streams) ? info.streams.map(record).find(row => row.codec_type === 'video') : undefined
  const duration = Number(format.duration), width = Number(stream?.width), height = Number(stream?.height)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width <= 0 || height <= 0 || width * height > 24_000_000 || typeof format.format_name !== 'string' || !format.format_name.includes('mp4')) throw new CloudError('观察视频格式、时长或尺寸无效', 422)
  if (timestamps !== undefined && (!Array.isArray(timestamps) || !timestamps.length || timestamps.length > 8 ||
    timestamps.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time >= duration))) throw new CloudError('抽帧时间点须为视频时长内的 1 到 8 个数字')
  const content = textResult({ path: file, sha256: expectedHash, video: { duration, width, height }, previewOnly: true, batchLimit: 8 }).content
  if (timestamps === undefined) return { content }
  const folder = await mkdtemp(path.join(root, 'video-preview-'))
  let deliveredBytes = 0
  for (const [index, time] of (timestamps as number[]).entries()) {
    signal.throwIfAborted()
    const destination = path.join(folder, `${index}.jpg`)
    await mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-threads', '1', '-ss', String(time), '-i', file,
      '-frames:v', '1', '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease', '-threads', '1', '-q:v', '3', destination], signal)
    const bytes = await readFile(destination)
    deliveredBytes += bytes.length
    if (deliveredBytes > 16 * 1024 * 1024) throw new CloudError('本批录屏预览超过 16 MiB 上限', 413)
    const receipt = { source: file, sourceSha256: expectedHash, timestamp: time, path: destination, sha256: sha256(bytes), previewOnly: true }
    await writeFile(`${destination}.json`, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    content.push({ type: 'text', text: JSON.stringify(receipt) }, { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') })
  }
  await verify()
  return { content }
}
