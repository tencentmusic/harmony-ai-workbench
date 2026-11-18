import {
  parseCreateIntegrationTaskInput,
  toIntegrationTaskListDto,
  toIntegrationTaskSummaryDto,
} from '@/server/modules/integration/public'
import {
  integrationErrorResponse,
  parseIntegrationTaskFilters,
  readIntegrationJsonBody,
} from '@/server/modules/integration/public'
import { loadIntegrationProjects, selectableIntegrationProjects } from '@/server/modules/integration/public'
import {
  createIntegrationTask,
  listIntegrationTasks,
} from '@/server/modules/integration/public'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const projects = loadIntegrationProjects()
    const filters = parseIntegrationTaskFilters(new URL(req.url), projects)
    const tasks = await listIntegrationTasks(filters)
    return Response.json(
      { items: toIntegrationTaskListDto(tasks) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}

export async function POST(req: Request) {
  try {
    const token = await verifyBearer(req.headers.get('authorization'))
    if (!token) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const body = await readIntegrationJsonBody(req)
    const projects = selectableIntegrationProjects(loadIntegrationProjects(), token.appScopeIds)
    const input = parseCreateIntegrationTaskInput(body, projects)
    const task = await createIntegrationTask({
      ...input,
      createdByTokenId: token.id,
    })
    return Response.json(
      { item: toIntegrationTaskSummaryDto(task) },
      {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      },
    )
  } catch (error) {
    return integrationErrorResponse(error)
  }
}
