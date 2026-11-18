import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import type { CloudAgentAttachment, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { CLOUD_MATERIAL_TOTAL, type CloudAttachment } from '@/contracts/cloud-agent'
import { CloudError } from './domain'
import { cloudProject } from './config'
import { requireApp, type CloudActor } from './http'
import { attachmentIds, materialFormat } from './material-domain'
import { prepareMaterial } from './material-processing'

export function materialDirectory(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new CloudError('附件身份无效')
  return path.join(path.resolve(process.env.CLOUD_AGENT_MATERIAL_ROOT || 'data/cloud-agent/materials'), id)
}
const directory = materialDirectory
export function attachmentDto(row: CloudAgentAttachment): CloudAttachment {
  return { id: row.id, name: row.name, mime: row.mime, kind: row.kind as CloudAttachment['kind'], size: row.size, sha256: row.sha256 }
}
export async function selectMaterialAttachments(tx: Prisma.TransactionClient, actor: CloudActor, appId: string, ids: string[], taskId?: string) {
  const rows = await tx.cloudAgentAttachment.findMany({ where: { id: { in: ids } } })
  const ordered = ids.map(id => rows.find(row => row.id === id))
  if (ordered.some(row => !row || row.status !== 'ready' || row.appId !== appId || (row.taskId ? row.taskId !== taskId : row.ownerId !== actor.id || row.createdAt.getTime() < Date.now() - 86400000))) throw new CloudError('附件已失效或无权使用，请重新上传', 403)
  const valid = ordered as CloudAgentAttachment[]
  if (valid.reduce((size, row) => size + row.size, 0) > CLOUD_MATERIAL_TOTAL) throw new CloudError('任务附件合计不能超过 200 MiB', 413)
  return valid
}
export async function attachMaterials(tx: Prisma.TransactionClient, taskId: string, ids: string[]) {
  await tx.cloudAgentAttachment.updateMany({ where: { id: { in: ids }, taskId: null, status: 'ready' }, data: { taskId } })
}
export async function uploadCloudMaterial(actor: CloudActor, req: Request) {
  const params = new URL(req.url).searchParams
  const appId = params.get('appId') || ''
  requireApp(actor, appId); cloudProject(appId)
  const name = params.get('name') || ''
  const format = materialFormat(name)
  const size = Number(req.headers.get('content-length'))
  if (!Number.isSafeInteger(size) || size <= 0 || size > format.maxSize) throw new CloudError(`附件大小须为 1 字节至 ${format.maxSize / 1024 / 1024} MiB`, 413)
  if (!req.body) throw new CloudError('附件为空')
  const id = randomUUID()
  await prisma.$transaction(async tx => {
    const active = await tx.cloudAgentAttachment.count({ where: { status: 'uploading', createdAt: { gt: new Date(Date.now() - 600000) } } })
    const staged = await tx.cloudAgentAttachment.aggregate({ where: { ownerId: actor.id, taskId: null }, _count: true, _sum: { size: true } })
    if (active >= 4 || staged._count >= 30 || (staged._sum.size || 0) + size > 500 * 1024 * 1024) throw new CloudError('上传繁忙或暂存附件过多，请保存已有材料后再试', 429)
    await tx.cloudAgentAttachment.create({ data: { id, appId, ownerId: actor.id, name, kind: format.kind, mime: format.mime, size } })
  })
  const location = directory(id)
  const reader = req.body.getReader()
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(180000)])
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await mkdir(location, { recursive: true, mode: 0o700 })
    const file = await open(path.join(location, 'original'), 'wx', 0o600)
    let received = 0
    const hash = createHash('sha256')
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > size) throw new CloudError('附件实际大小超过声明值', 413)
        hash.update(value)
        await file.writeFile(value)
      }
    } finally { await file.close() }
    signal.throwIfAborted()
    if (received !== size) throw new CloudError('附件上传不完整，请重试')
    await prepareMaterial(location, name, signal)
    signal.throwIfAborted()
    const row = await prisma.cloudAgentAttachment.update({ where: { id }, data: { status: 'ready', sha256: hash.digest('hex') } })
    return attachmentDto(row)
  } catch (error) {
    await reader.cancel().catch(() => {})
    await rm(location, { recursive: true, force: true })
    await prisma.cloudAgentAttachment.deleteMany({ where: { id, taskId: null } })
    if (signal.aborted) throw new CloudError('上传或解析超时，请拆分材料后重试', 408)
    throw error
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
}
export async function downloadCloudMaterial(actor: CloudActor, id: string) {
  const row = await prisma.cloudAgentAttachment.findUnique({ where: { id }, include: { task: { select: { appId: true } } } })
  if (!row || row.status !== 'ready' || !actor.appIds.includes(row.appId) || (row.task ? row.task.appId !== row.appId : row.ownerId !== actor.id)) throw new CloudError('附件不存在或无权限', 404)
  const file = path.join(directory(id), 'original')
  const handle = await open(file, 'r').catch(() => { throw new CloudError('附件文件缺失，请联系管理员恢复', 404) })
  const stream = handle.createReadStream()
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
    'content-type': row.mime, 'content-length': String(row.size), 'content-disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g, '%27')}`,
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  } })
}
let lastCleanup = 0
export async function cleanupStagedMaterials() {
  if (Date.now() - lastCleanup < 60000) return
  lastCleanup = Date.now()
  const rows = await prisma.cloudAgentAttachment.findMany({ where: { taskId: null, OR: [
    { createdAt: { lt: new Date(Date.now() - 86400000) } },
    { status: 'uploading', createdAt: { lt: new Date(Date.now() - 600000) } },
  ] }, take: 50 })
  for (const row of rows) {
    const deleted = await prisma.cloudAgentAttachment.deleteMany({ where: { id: row.id, taskId: null } })
    if (deleted.count) await rm(directory(row.id), { recursive: true, force: true })
  }
}
export function savedAttachmentIds(value: string) { return attachmentIds(JSON.parse(value)) }
