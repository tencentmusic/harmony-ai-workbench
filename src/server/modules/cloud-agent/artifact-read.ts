import { readFile, stat } from 'node:fs/promises'
import sharp from 'sharp'
import { CloudError } from './domain'
import { readScoped, scopedPath, sha256 } from './scoped-files'
import { textResult } from './task-tools'

export async function readArtifact(root: string, relative: unknown, offset = 0) {
  if (typeof relative !== 'string' || !/\.(png|jpe?g|webp)$/i.test(relative)) {
    return textResult(await readScoped(root, relative, [''], offset))
  }
  const file = await scopedPath(root, relative, ['']).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CloudError('图片不存在；请先用 artifact_list 核对相对路径', 404)
    throw error
  })
  if (offset !== 0) throw new CloudError('图片读取不支持文本偏移')
  const info = await stat(file)
  if (!info.isFile() || info.size > 12 * 1024 * 1024) throw new CloudError('图片必须为不超过 12 MiB 的普通文件', 413)
  const bytes = await readFile(file)
  try {
    const image = sharp(bytes, { limitInputPixels: 24_000_000 })
    const metadata = await image.metadata()
    if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) {
      throw new CloudError('只支持单帧 PNG/JPEG/WebP 图片', 422)
    }
    const preview = await image.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer()
    return { content: [
      ...textResult({ path: file, relativePath: relative, sha256: sha256(bytes), originalWidth: metadata.width,
        originalHeight: metadata.height, previewOnly: true, nextOffset: null }).content,
      { type: 'image' as const, mimeType: 'image/jpeg', data: preview.toString('base64') },
    ] }
  } catch (error) {
    if (error instanceof CloudError) throw error
    throw new CloudError('图片无法解码或超过 2400 万像素；请核对原始图片', 422)
  }
}
