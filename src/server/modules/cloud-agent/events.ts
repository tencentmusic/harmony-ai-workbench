import { prisma } from '@/lib/prisma'
import { requireCloudActor } from './http'
import { cloudEvents, getCloudTask } from './store'

export async function streamCloudEvents(req: Request, taskId?: string) {
  const actor = await requireCloudActor(req)
  if (taskId) await getCloudTask(actor, taskId)
  const supplied = new URL(req.url).searchParams.get('after')
  let cursor = Number(supplied || 0)
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0
  if (!taskId && supplied === null) cursor = (await prisma.cloudAgentEvent.findFirst({ where: { task: { appId: { in: actor.appIds } } }, orderBy: { id: 'desc' }, select: { id: true } }))?.id || 0
  const encoder = new TextEncoder()
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + 55000
      const emit = (text: string) => { if (!closed && !req.signal.aborted) controller.enqueue(encoder.encode(text)) }
      emit(`event: ready\ndata: ${JSON.stringify({ cursor })}\n\n`)
      try {
        while (!closed && !req.signal.aborted && Date.now() < deadline) {
          const current = await requireCloudActor(req)
          const events = taskId ? await cloudEvents(current, taskId, cursor) : await prisma.cloudAgentEvent.findMany({
            where: { id: { gt: cursor }, task: { appId: { in: current.appIds } }, kind: { not: 'output' } }, orderBy: { id: 'asc' }, take: 200,
            select: { id: true, taskId: true, kind: true },
          })
          for (const event of events) { emit(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.id }
          emit(': heartbeat\n\n')
          await new Promise(resolve => setTimeout(resolve, events.length === 200 ? 0 : 1000))
        }
      } catch { emit('event: auth-or-stream-error\ndata: {}\n\n') }
      finally { if (!closed) { closed = true; controller.close() } }
    },
    cancel() { closed = true },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
}
