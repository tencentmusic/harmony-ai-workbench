import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { CloudError } from './domain'
import { materialFormat } from './material-domain'

export interface PreparedMaterial { text: string; warnings: string[]; files: { name: string; mime: string; label: string }[]; video?: { duration: number; width: number; height: number } }
export interface MaterialPart { type: 'file'; mime: string; filename: string; url: string }
const execute = promisify(execFile)
export async function mediaTool(tool: 'ffmpeg' | 'ffprobe', args: string[], signal: AbortSignal) {
  try {
    return await execute(process.env[tool === 'ffmpeg' ? 'CLOUD_AGENT_FFMPEG_BIN' : 'CLOUD_AGENT_FFPROBE_BIN'] || tool, args,
      { shell: false, windowsHide: true, timeout: 60000, maxBuffer: 512000, signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new CloudError('视频解析失败：请确认 FFmpeg/FFprobe 已安装，且视频可播放、编码受支持', 422)
  }
}
async function safeDocx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files).filter(file => !file.dir)
  if (entries.length > 500 || !zip.file('word/document.xml')) throw new CloudError('DOCX 内容无效或文件过于复杂', 422)
  let expanded = 0
  for (const file of entries) {
    const stream = file.nodeStream('nodebuffer')
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Uint8Array) => {
        expanded += chunk.length
        if (expanded > 20 * 1024 * 1024) { stream.pause(); reject(new CloudError('DOCX 解压内容超过 20 MiB，请精简图片或拆分文档', 413)) }
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  }
  return (await mammoth.extractRawText({ buffer })).value
}
export async function prepareMaterial(directory: string, name: string, signal: AbortSignal): Promise<PreparedMaterial> {
  const format = materialFormat(name)
  const source = path.join(directory, 'original')
  const result: PreparedMaterial = { text: '', files: [], warnings: [] }
  signal.throwIfAborted()
  try {
    if (format.kind === 'video') {
      const { stdout } = await mediaTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height', '-of', 'json', source], signal)
      const info = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] }
      const duration = Number(info.format?.duration)
      const video = info.streams?.find(stream => stream.codec_type === 'video')
      const container = info.format?.format_name || ''
      if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 600 || (video.width || 0) * (video.height || 0) > 16_800_000 ||
        !(format.extension === 'webm' ? container.includes('webm') : container.includes('mov') || container.includes('mp4'))) throw new CloudError('视频格式无效，或超过 10 分钟 / 4K 上限', 422)
      result.video = { duration, width: video.width || 0, height: video.height || 0 }
      result.text = `视频 ${name}：时长 ${duration.toFixed(1)} 秒；原件已保存，由 Agent 按 Harness 规则选择时间点抽帧与补帧。未转写音频。`
    } else {
      const buffer = await readFile(source)
      if (format.kind === 'image') {
        const converter = sharp(buffer, { limitInputPixels: 25_000_000, failOn: 'error' })
        const metadata = await converter.metadata()
        if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) throw new CloudError('仅支持 PNG、JPEG、WebP 静态图片', 422)
        const expected = format.extension === 'jpg' ? 'jpeg' : format.extension
        if (metadata.format !== expected) throw new CloudError('图片内容与扩展名不符', 422)
        await converter.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(directory, 'image.jpg'))
        result.files.push({ name: 'image.jpg', mime: 'image/jpeg', label: name })
      } else if (format.extension === 'pdf') {
        if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) || !buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new CloudError('PDF 文件无效', 422)
        result.files.push({ name: 'original', mime: 'application/pdf', label: name })
      } else if (format.extension === 'docx') {
        result.text = await safeDocx(buffer)
        if (!result.text.trim()) throw new CloudError('DOCX 没有可读取正文，请将扫描件导出为 PDF 或图片', 422)
        result.text = `DOCX 仅提取正文，内嵌设计图需单独补充为图片。\n${result.text}`
      } else {
        result.text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        if (result.text.includes('\0') || !result.text.trim()) throw new CloudError('请上传 UTF-8 编码的非空文本文档', 422)
      }
    }
    if (result.text.length > 60000) { result.text = result.text.slice(0, 60000); result.warnings.push(`${name} 正文超出 60000 字符，仅提取前段，请拆分补充。`) }
    await writeFile(path.join(directory, 'prepared.json'), JSON.stringify(result), { mode: 0o600 })
    return result
  } catch (error) {
    if (error instanceof CloudError || signal.aborted) throw error
    throw new CloudError('附件内容无法解析，请确认文件完整且格式正确', 422)
  }
}
