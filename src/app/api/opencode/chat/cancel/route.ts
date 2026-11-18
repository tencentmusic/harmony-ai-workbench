import { NextRequest } from 'next/server'

import { cancelChatAgentRun } from '@/lib/agent-chat-cancel'
import {
  cancelActiveOpencodeRequestForChatSession,
  getActiveOpencodeRequestForChatSession,
} from '@/lib/opencode-request-store'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CancelBody = {
  chatSessionId?: unknown
}

export async function POST(req: NextRequest) {
  const tok = await verifyBearer(req.headers.get('authorization'))
  if (!tok) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: CancelBody
  try {
    body = (await req.json()) as CancelBody
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId.trim() : ''
  if (!chatSessionId) {
    return Response.json({ error: 'chat_session_id_required' }, { status: 400 })
  }

  cancelChatAgentRun(chatSessionId)

  await cancelActiveOpencodeRequestForChatSession({
    chatSessionId,
    tokenId: tok.id,
  })

  return Response.json({ ok: true })
}
