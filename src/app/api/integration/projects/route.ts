import { toPublicIntegrationProjects } from '@/server/modules/integration/public'
import { loadIntegrationProjects, selectableIntegrationProjects } from '@/server/modules/integration/public'
import { integrationErrorResponse } from '@/server/modules/integration/public'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const configured = loadIntegrationProjects()
    const projects = [
      ...selectableIntegrationProjects(configured, token.appScopeIds),
      ...configured.filter(project => project.selectable === false),
    ]
    return Response.json(
      { items: toPublicIntegrationProjects(projects) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
