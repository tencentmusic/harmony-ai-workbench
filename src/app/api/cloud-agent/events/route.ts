import { streamCloudEvents, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(req: Request) {
  try { return await streamCloudEvents(req) }
  catch (error) { return cloudErrorResponse(error) }
}
