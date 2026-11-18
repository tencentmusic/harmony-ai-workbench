import { requireCloudActor, downloadCloudMaterial, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try { return await downloadCloudMaterial(await requireCloudActor(req), (await context.params).id) }
  catch (error) { return cloudErrorResponse(error) }
}
