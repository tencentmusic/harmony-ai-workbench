import { requireCloudActor, uploadCloudMaterial, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function POST(req: Request) {
  try { return Response.json({ item: await uploadCloudMaterial(await requireCloudActor(req), req) }, { status: 201, headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
