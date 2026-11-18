import { requireCloudActor, cloudErrorResponse, visualReportResponse } from '@/server/modules/cloud-agent/public'

export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return await visualReportResponse(await requireCloudActor(request), (await context.params).id, new URL(request.url)) }
  catch (error) { return cloudErrorResponse(error) }
}
