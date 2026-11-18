import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/token'
import { CloudError } from './domain'
import { cloudAppIdsForToken } from './access'

export interface CloudActor { id: string; appIds: string[] }
export async function requireCloudActor(req: Request): Promise<CloudActor> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ') || auth.length > 1024) throw new CloudError('请先登录', 401)
  const token = await prisma.apiToken.findFirst({ where: { tokenHash: hashToken(auth.slice(7).trim()), revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } })
  if (!token) throw new CloudError('登录已失效', 401)
  return { id: token.id, appIds: await cloudAppIdsForToken(token.id) }
}
export function requireApp(actor: CloudActor, appId: string) { if (!actor.appIds.includes(appId)) throw new CloudError('没有此 App 权限', 403) }
export async function readCloudBody(req: Request, limit = 256_000): Promise<unknown> {
  const reader = req.body?.getReader()
  if (!reader) throw new CloudError('请求体为空')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new CloudError('材料超过大小限制', 413) }
      parts.push(value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
  } catch (error) { if (error instanceof CloudError) throw error; throw new CloudError('请求格式错误') }
  finally { reader.releaseLock() }
}
export function cloudErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof CloudError ? error.message : '云Agent 请求失败，请稍后重试' }, { status: error instanceof CloudError ? error.status : 500, headers: { 'cache-control': 'no-store' } })
}
