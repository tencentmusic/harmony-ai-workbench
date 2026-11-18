import { CLOUD_MATERIAL_COUNT, type CloudAttachment } from '@/contracts/cloud-agent'
import { CloudError, record } from './domain'

const formats: Record<string, [CloudAttachment['kind'], string]> = {
  pdf: ['document', 'application/pdf'], docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['document', 'text/plain'], md: ['document', 'text/markdown'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'],
  mp4: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'], webm: ['video', 'video/webm'],
}
export function materialFormat(name: string) {
  if (!name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name) || name.startsWith('.')) throw new CloudError('附件名称无效')
  const extension = name.split('.').at(-1)?.toLowerCase() || ''
  const format = formats[extension]
  if (!format) throw new CloudError('不支持此附件格式，请使用 PDF、DOCX、TXT、MD、PNG、JPEG、WebP、MP4、MOV 或 WebM')
  return { extension, kind: format[0], mime: format[1], maxSize: (format[0] === 'video' ? 100 : 10) * 1024 * 1024 }
}
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > CLOUD_MATERIAL_COUNT || !value.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)) || new Set(value).size !== value.length) throw new CloudError('附件列表无效或超过 10 个')
  return value
}
export function parseMaterialEdit(value: unknown) {
  const row = record(value)
  if (!Number.isSafeInteger(row.materialVersion) || Number(row.materialVersion) < 1) throw new CloudError('缺少材料版本')
  if (typeof row.material !== 'string' || row.material.length > 60000) throw new CloudError('需求材料格式错误或过长')
  const ids = attachmentIds(row.attachmentIds)
  const material = row.material.trim()
  if (!material && !ids.length) throw new CloudError('请填写文字或上传附件')
  if (row.reanalyze !== undefined && typeof row.reanalyze !== 'boolean') throw new CloudError('重新分析参数无效')
  return { material, materialVersion: Number(row.materialVersion), attachmentIds: ids, reanalyze: row.reanalyze === true }
}
