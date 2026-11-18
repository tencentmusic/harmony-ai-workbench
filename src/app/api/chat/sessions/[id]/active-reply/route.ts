import { resolveAgentBackend } from '@/lib/agent-backend'
import {
  expireStaleOpencodeRequestsForToken,
  getActiveOpencodeRequestForChatSession,
} from '@/lib/opencode-request-store'
import { getSessionByIdForToken, listRecentMessagesBySessionForToken } from '@/lib/chat-store'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get('authorization'))
  if (!tok) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { id: chatSessionId } = await ctx.params
  const session = await getSessionByIdForToken(chatSessionId, tok.id)
  if (!session) return Response.json({ error: 'not_found' }, { status: 404 })

  await expireStaleOpencodeRequestsForToken(tok.id)

  const running = await getActiveOpencodeRequestForChatSession({
    chatSessionId,
    tokenId: tok.id,
  })

  if (running) {
    return Response.json({
      active: true,
      status: 'running',
      recordId: running.id,
      partial: running.assistantOutput || '',
      agentSessionId: running.opencodeSessionId,
      backend: resolveAgentBackend(),
    })
  }

  const recent = await listRecentMessagesBySessionForToken({
    sessionId: chatSessionId,
    tokenId: tok.id,
    limit: 2,
  })
  const last = recent?.[recent.length - 1]
  const pendingUserOnly = last?.role === 'user'

  return Response.json({
    active: false,
    status: 'idle',
    pendingUserOnly,
    backend: resolveAgentBackend(),
  })
}
