import { requireCloudActor, listCloudBranches, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try { return Response.json({ items: await listCloudBranches(await requireCloudActor(req), new URL(req.url).searchParams.get('appId') || '') }, { headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
