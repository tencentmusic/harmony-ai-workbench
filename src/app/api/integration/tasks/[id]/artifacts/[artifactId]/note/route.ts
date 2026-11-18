import {
  parseIntegrationReviewNoteInput,
  toIntegrationTaskDetailDto,
} from '@/server/modules/integration/public'
import {
  IntegrationHttpError,
  integrationErrorResponse,
  readIntegrationJsonBody,
  requireIntegrationResourceId,
} from '@/server/modules/integration/public'
import {
  getIntegrationTask,
  updateIntegrationArtifactReviewNote,
} from '@/server/modules/integration/public'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string, artifactId: string }>
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { id: rawTaskId, artifactId: rawArtifactId } = await context.params
    const taskId = requireIntegrationResourceId(rawTaskId)
    const artifactId = requireIntegrationResourceId(rawArtifactId)
    const input = parseIntegrationReviewNoteInput(await readIntegrationJsonBody(req))
    await updateIntegrationArtifactReviewNote({
      taskId,
      artifactId,
      note: input.note,
      expectedUpdatedAt: input.expectedUpdatedAt,
      actorTokenId: token.id,
    })

    const task = await getIntegrationTask(taskId)
    if (!task) throw new IntegrationHttpError('TASK_NOT_FOUND', 404)
    return Response.json(
      { item: toIntegrationTaskDetailDto(task) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
