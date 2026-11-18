import {
  parseIntegrationRerunInput,
  toIntegrationTaskSummaryDto,
} from '@/server/modules/integration/public'
import {
  IntegrationHttpError,
  integrationErrorResponse,
  readIntegrationJsonBody,
  requireIntegrationResourceId,
} from '@/server/modules/integration/public'
import {
  getIntegrationTask,
  rerunIntegrationStage,
} from '@/server/modules/integration/public'
import { enqueueIntegrationRun } from '@/server/modules/integration/public'
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
    const input = parseIntegrationRerunInput(await readIntegrationJsonBody(req))
    const run = await rerunIntegrationStage({
      taskId,
      stage: input.stage,
      expectedRunId: input.expectedRunId,
    })
    enqueueIntegrationRun(run.id)

    const task = await getIntegrationTask(taskId)
    if (!task) throw new IntegrationHttpError('TASK_NOT_FOUND', 404)
    return Response.json(
      { item: toIntegrationTaskSummaryDto(task) },
      {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
