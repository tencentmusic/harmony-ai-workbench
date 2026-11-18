import { requireCloudActor, getCloudTask, decideCloudTask, deleteCloudTask, readCloudBody, cloudErrorResponse } from '@/server/modules/cloud-agent/public'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(req: Request, context: Context) {
  try { return Response.json({ item: await getCloudTask(await requireCloudActor(req), (await context.params).id) }, { headers: { 'cache-control': 'no-store' } }) }
  catch (error) { return cloudErrorResponse(error) }
}
export async function DELETE(req: Request, context: Context) {
  try { await deleteCloudTask(await requireCloudActor(req), (await context.params).id); return Response.json({ ok: true }) }
  catch (error) { return cloudErrorResponse(error) }
}
export async function PATCH(req: Request, context: Context) {
  try {
    const actor = await requireCloudActor(req)
    return Response.json({ item: await decideCloudTask(actor, (await context.params).id, await readCloudBody(req)) })
  } catch (error) { return cloudErrorResponse(error) }
}
