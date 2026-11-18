import { requireCloudActor, listCloudTasks, createCloudTask, readCloudBody, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try { return Response.json(await listCloudTasks(await requireCloudActor(req), new URL(req.url)), { headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
export async function POST(req: Request) {
  try {
    const actor = await requireCloudActor(req)
    return Response.json({ item: await createCloudTask(actor, await readCloudBody(req)) }, { status: 201 })
  } catch (error) { return cloudErrorResponse(error) }
}
