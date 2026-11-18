import { requireCloudActor, listCloudRuns, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try { return Response.json(await listCloudRuns(await requireCloudActor(req), (await context.params).id, new URL(req.url)), { headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
