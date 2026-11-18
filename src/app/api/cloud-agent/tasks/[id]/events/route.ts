import { streamCloudEvents, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id
    return await streamCloudEvents(req, id)
  } catch (error) { return cloudErrorResponse(error) }
}
