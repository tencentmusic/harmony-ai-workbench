import {
  checkLatestIntegrationTaskConflicts,
  IntegrationConflictCheckBusyError,
} from '@/server/modules/integration/public'
import { IntegrationGitError } from '@/server/modules/integration/public'
import {
  IntegrationHttpError,
  integrationErrorResponse,
  requireIntegrationResourceId,
} from '@/server/modules/integration/public'
import { loadIntegrationProjects } from '@/server/modules/integration/public'
import { getIntegrationTask } from '@/server/modules/integration/public'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { id: rawId } = await context.params
    const taskId = requireIntegrationResourceId(rawId)
    const task = await getIntegrationTask(taskId)
    if (!task) {
      throw new IntegrationHttpError('TASK_NOT_FOUND', 404)
    }
    if (task.status !== 'merge_pending') {
      throw new IntegrationHttpError('CONFLICT_CHECK_NOT_ALLOWED', 409)
    }

    const project = loadIntegrationProjects().find(
      (candidate) => candidate.id === task.projectId,
    )
    if (!project) {
      throw new IntegrationHttpError('PROJECT_NOT_FOUND', 404, 'projectId')
    }

    try {
      const result = await checkLatestIntegrationTaskConflicts({ task, project })

      return Response.json(
        { item: result },
        { headers: { 'cache-control': 'no-store' } },
      )
    } catch (error) {
      if (error instanceof IntegrationConflictCheckBusyError) {
        throw new IntegrationHttpError('CONFLICT_CHECK_BUSY', 429)
      }
      if (error instanceof IntegrationGitError) {
        throw new IntegrationHttpError('MERGE_CONFLICT_CHECK_FAILED', 500)
      }
      throw error
    }
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
