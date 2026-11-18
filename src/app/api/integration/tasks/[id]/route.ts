import {
  parseIntegrationStatusUpdateInput,
  toIntegrationTaskDetailDto,
  toIntegrationTaskSummaryDto,
} from '@/server/modules/integration/public'
import {
  IntegrationHttpError,
  integrationErrorResponse,
  readIntegrationJsonBody,
  requireIntegrationResourceId,
} from '@/server/modules/integration/public'
import {
  deleteIntegrationTask,
  getIntegrationTask,
  transitionIntegrationTaskStatus,
} from '@/server/modules/integration/public'
import { enqueueIntegrationRun } from '@/server/modules/integration/public'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { id: rawId } = await context.params
    const id = requireIntegrationResourceId(rawId)
    const task = await getIntegrationTask(id)
    if (!task) {
      throw new IntegrationHttpError('TASK_NOT_FOUND', 404)
    }
    return Response.json(
      { item: toIntegrationTaskDetailDto(task) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { id: rawId } = await context.params
    const taskId = requireIntegrationResourceId(rawId)
    const body = await readIntegrationJsonBody(req)
    const input = parseIntegrationStatusUpdateInput(body)
    const result = await transitionIntegrationTaskStatus({
      taskId,
      expectedStatus: input.expectedStatus,
      status: input.status,
      actorTokenId: token.id,
    })
    if (result.run) {
      enqueueIntegrationRun(result.run.id)
    }
    return Response.json(
      { item: toIntegrationTaskSummaryDto(result.task) },
      {
        status: result.run ? 202 : 200,
        headers: { 'cache-control': 'no-store' },
      },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { id: rawId } = await context.params
    const taskId = requireIntegrationResourceId(rawId)
    await deleteIntegrationTask(taskId)
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
