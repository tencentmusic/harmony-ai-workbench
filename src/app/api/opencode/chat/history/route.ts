import { NextRequest } from 'next/server'
import {
  buildOpencodeHeaders,
  OpencodeConfigError,
  getOpencodeConfig,
} from '@/lib/opencode/opencode-config'
import { convertOpencodeMessages, type OpencodeMessageRaw } from '@/lib/opencode/opencode-history'
import { isValidOpencodeSessionId } from '@/lib/opencode/opencode-session'
import { tokenOwnsOpencodeSession } from '@/lib/opencode-request-store'
import { verifyBearer } from '@/lib/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const tok = await verifyBearer(req.headers.get('authorization'))
  if (!tok) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!isValidOpencodeSessionId(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 })
  }
  if (!await tokenOwnsOpencodeSession({
    tokenId: tok.id,
    opencodeSessionId: sessionId,
  })) {
    return Response.json({ error: 'session_not_found' }, { status: 404 })
  }

  let cfg
  try {
    cfg = getOpencodeConfig()
  } catch (err) {
    if (err instanceof OpencodeConfigError) {
      return Response.json({ error: err.code }, { status: 500 })
    }
    throw err
  }

  let upstream: Response
  try {
    upstream = await fetch(`${cfg.baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
      headers: buildOpencodeHeaders(cfg, { Accept: 'application/json' }),
    })
  } catch {
    return Response.json({ error: 'upstream_unavailable' }, { status: 502 })
  }

  if (upstream.status === 404 || upstream.status === 400) {
    return Response.json({ error: 'session_not_found' }, { status: 404 })
  }
  if (!upstream.ok) {
    return Response.json({ error: `upstream_${upstream.status}` }, { status: 502 })
  }

  const raw = (await upstream.json()) as OpencodeMessageRaw[]
  const messages = convertOpencodeMessages(raw)
  return Response.json({ sessionId, messages })
}
