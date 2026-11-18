import { requireCloudActor, saveCloudMaterials, readCloudBody, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try { return Response.json({ item: await saveCloudMaterials(await requireCloudActor(req), (await context.params).id, await readCloudBody(req)) }, { headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
