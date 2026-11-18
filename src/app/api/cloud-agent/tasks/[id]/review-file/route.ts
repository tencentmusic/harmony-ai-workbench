import { requireCloudActor, downloadReviewFile, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try { return await downloadReviewFile(await requireCloudActor(req), (await context.params).id, new URL(req.url)) }
  catch (error) { return cloudErrorResponse(error) }
}
