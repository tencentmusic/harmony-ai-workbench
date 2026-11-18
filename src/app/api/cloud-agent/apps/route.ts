import { requireCloudActor, listCloudApps, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try {
    const actor = await requireCloudActor(req)
    return Response.json({ items: await listCloudApps(actor) }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) { return cloudErrorResponse(error) }
}
