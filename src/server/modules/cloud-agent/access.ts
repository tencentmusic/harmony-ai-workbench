import { prisma } from '@/lib/prisma'
import { listTokenAppScopeIds } from '@/lib/token-app-scopes'
import { cloudProjects } from './config'

export async function cloudAppIdsForToken(tokenId: string): Promise<string[]> {
  const scopes = await listTokenAppScopeIds(tokenId)
  const allowed = new Set(scopes)
  return cloudProjects().filter(app => !scopes.length || allowed.has(app.id)).map(app => app.id)
}

export async function tokenCanAccessCloudApp(tokenId: string, appId: string): Promise<boolean> {
  const token = await prisma.apiToken.findFirst({
    where: { id: tokenId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true },
  })
  return !!token && (await cloudAppIdsForToken(tokenId)).includes(appId)
}
