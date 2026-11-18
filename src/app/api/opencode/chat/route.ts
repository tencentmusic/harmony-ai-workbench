import { NextRequest } from 'next/server'

import {
  beginChatAgentRun,
  shouldAbortChatAgentRun,
} from '@/lib/agent-chat-cancel'
import { appendMessageToSessionForToken, listRecentMessagesBySessionForToken, patchChatMessageMetadataForToken } from '@/lib/chat-store'
import {
  parseAgentSessionId,
  resolveAgentModelLabel,
  streamChat,
} from '@/lib/agent-backend'
import type { ChatStreamEvent } from '@/lib/agent-backend'
import { augmentOpencodeMessage, resolveRequestedAppScopeId } from '@/lib/opencode/opencode-app-scope'
import { classifyOpencodeIntent } from '@/lib/opencode/opencode-intent'
import { dedupeOpencodeImages, type OpencodeImageRef } from '@/lib/opencode/opencode-image'
import {
  createOpencodeRequest,
  extractClassHintFromPrompt,
  finishOpencodeRequestIfRunning,
  resolveAppScopeModuleLabel,
  resolveLatestOpencodeSessionForChatSession,
  updateOpencodeRequestProgress,
  getActiveOpencodeRequestForChatSession,
  tokenOwnsOpencodeSession,
} from '@/lib/opencode-request-store'
import { isValidOpencodeSessionId, reconcileOpencodeSessionId } from '@/lib/opencode/opencode-session'
import { resolveOpencodeChatContinuity } from '@/lib/opencode/opencode-session-continuity'
import { verifyBearer } from '@/lib/token'
import { resolveKbProjectIdForChat } from '@/lib/kb-project-labels'
import type { KnowledgeLocator } from '@/contracts/knowledge'
import {
  KnowledgeAccessError,
  resolveKnowledgeLocatorFromMessage,
  validateKnowledgeLocator,
} from '@/server/modules/knowledge/public'
import {
  beginKbTelemetryTurn,
  bindOpencodeSessionToTrace,
  finishKbTelemetryTurn,
  trackKbOutputChars,
  trackKbTurnMeta,
} from '@/lib/kb-telemetry-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ChatRequestBody = {
  message?: unknown
  sessionId?: unknown
  appScopeId?: unknown
  chatSessionId?: unknown
  classRefs?: unknown
  attachments?: unknown
  knowledgeLocator?: unknown
}

function parseKnowledgeLocator(raw: unknown): KnowledgeLocator | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const locator = {
    libraryId: String(value.libraryId || '').trim(),
    sourceId: String(value.sourceId || '').trim(),
    workspaceAlias: String(value.workspaceAlias || '').trim(),
    docPath: String(value.docPath || '').trim(),
    ...(typeof value.appScopeId === 'string' && value.appScopeId.trim()
      ? { appScopeId: value.appScopeId.trim() }
      : {}),
  }
  return locator.libraryId && locator.sourceId && locator.workspaceAlias && locator.docPath ? locator : null
}

const CHAT_ATTACHMENT_MAX_COUNT = 5
const CHAT_ATTACHMENT_MAX_SIZE = 6 * 1024 * 1024
const CHAT_ATTACHMENT_ROOT = 'user-uploads'

function normalizeSlashes(raw: string) {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '')
}

function basenameOnly(raw: string) {
  const normalized = normalizeSlashes(String(raw || '').trim())
  const parts = normalized.split('/')
  return parts[parts.length - 1] || normalized
}

function inferAttachmentMime(name: string, mime?: string | null) {
  const provided = String(mime || '').trim().toLowerCase()
  if (provided) return provided
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

function normalizeChatAttachments(raw: unknown) {
  if (!Array.isArray(raw)) return []
  const out: Array<{ path: string; name: string; mime: string; size: number; kind: 'image' | 'file'; dataUrl?: string }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const pathValue = normalizeSlashes(String((item as { path?: unknown }).path || '').trim())
    const name = basenameOnly(String((item as { name?: unknown }).name || '').trim())
    const mime = inferAttachmentMime(name, String((item as { mime?: unknown }).mime || ''))
    const size = Number((item as { size?: unknown }).size || 0)
    const dataUrl = typeof (item as { dataUrl?: unknown }).dataUrl === 'string' ? String((item as { dataUrl?: unknown }).dataUrl) : ''
    if (!pathValue.startsWith(`${CHAT_ATTACHMENT_ROOT}/`) || pathValue.includes('..')) continue
    if (!name || seen.has(pathValue)) continue
    if (!Number.isFinite(size) || size < 0 || size > CHAT_ATTACHMENT_MAX_SIZE) continue
    seen.add(pathValue)
    out.push({
      path: pathValue,
      name,
      mime,
      size,
      kind: mime.startsWith('image/') ? 'image' : 'file',
      ...(dataUrl.startsWith('data:') ? { dataUrl } : {}),
    })
    if (out.length >= CHAT_ATTACHMENT_MAX_COUNT) break
  }
  return out
}

function parseClassRefs(raw: unknown) {
  if (!Array.isArray(raw)) return [] as Array<{ fqn: string; module?: string }>
  const out: Array<{ fqn: string; module?: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const fqn = typeof (item as { fqn?: unknown }).fqn === 'string' ? (item as { fqn: string }).fqn.trim() : ''
    if (!fqn) continue
    const module =
      typeof (item as { module?: unknown }).module === 'string'
        ? (item as { module: string }).module.trim()
        : undefined
    out.push({ fqn, module: module || undefined })
  }
  return out
}

type QueueItem = ChatStreamEvent | { type: 'close' }

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status })
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  const host = req.headers.get('host')
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function persistAssistantReply(opts: {
  chatSessionId: string
  tokenId: string
  content: string
  agentSessionId: string | null
  images: OpencodeImageRef[]
  appScopeId: string
  interrupted?: boolean
  reasoning?: string
  error?: string | null
}) {
  const recent = await listRecentMessagesBySessionForToken({
    sessionId: opts.chatSessionId,
    tokenId: opts.tokenId,
    limit: 3,
  })
  const last = recent?.[recent.length - 1]
  if (last?.role === 'assistant') {
    const existingSessionId =
      typeof last.metadata?.opencodeSessionId === 'string' ? last.metadata.opencodeSessionId.trim() : ''
    if (!existingSessionId && opts.agentSessionId) {
      await patchChatMessageMetadataForToken({
        messageId: last.id,
        sessionId: opts.chatSessionId,
        tokenId: opts.tokenId,
        metadata: {
          ...(last.metadata || {}),
          mode: 'opencode',
          backend: 'opencode',
          opencodeSessionId: opts.agentSessionId,
          ...(opts.appScopeId ? { appScopeId: opts.appScopeId } : {}),
          ...(opts.images.length ? { images: opts.images } : {}),
          ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
          ...(opts.interrupted ? { interrupted: true, error: opts.error || 'opencode_stream_interrupted' } : {}),
        },
      })
    }
    return
  }

  const metadata: Record<string, unknown> = {
    mode: 'opencode',
    backend: 'opencode',
  }
  if (opts.agentSessionId) metadata.opencodeSessionId = opts.agentSessionId
  if (opts.appScopeId) metadata.appScopeId = opts.appScopeId
  if (opts.images.length) metadata.images = opts.images
  if (opts.reasoning) metadata.reasoning = opts.reasoning
  if (opts.interrupted) {
    metadata.interrupted = true
    metadata.error = opts.error || 'opencode_stream_interrupted'
  }

  await appendMessageToSessionForToken({
    sessionId: opts.chatSessionId,
    tokenId: opts.tokenId,
    role: 'assistant',
    content: opts.content,
    metadata,
  })
}

async function resolveActiveOpencodeSessionForChat(opts: {
  requestedSessionId: string | null
  chatSessionId: string | null
  tokenId: string
}): Promise<string | null> {
  const candidates: string[] = []
  if (opts.requestedSessionId) candidates.push(opts.requestedSessionId)
  if (opts.chatSessionId) {
    const fromStore = await resolveLatestOpencodeSessionForChatSession({
      chatSessionId: opts.chatSessionId,
      tokenId: opts.tokenId,
    })
    if (fromStore && !candidates.includes(fromStore)) candidates.push(fromStore)
  }

  for (const candidate of candidates) {
    if (!isValidOpencodeSessionId(candidate)) continue
    const owned = await tokenOwnsOpencodeSession({
      tokenId: opts.tokenId,
      opencodeSessionId: candidate,
      chatSessionId: opts.chatSessionId,
    })
    if (!owned) continue
    const reconciled = await reconcileOpencodeSessionId(candidate)
    if (reconciled) return reconciled
  }

  return null
}

export async function POST(req: NextRequest) {
  const tok = await verifyBearer(req.headers.get('authorization'))
  if (!tok) return jsonError('unauthorized', 401)
  if (!isSameOrigin(req)) return jsonError('forbidden_origin', 403)

  let body: ChatRequestBody
  try {
    body = (await req.json()) as ChatRequestBody
  } catch {
    return jsonError('invalid_json', 400)
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const attachments = normalizeChatAttachments(body.attachments)
  if (!message && !attachments.length) return jsonError('empty_message', 400)

  const requestedAppScopeId = typeof body.appScopeId === 'string' ? body.appScopeId.trim() : ''
  const allowedScopeIds = Array.isArray(tok.appScopeIds)
    ? tok.appScopeIds.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  let appScopeId = resolveRequestedAppScopeId(requestedAppScopeId, allowedScopeIds)
  const requestedKnowledgeLocator = parseKnowledgeLocator(body.knowledgeLocator)
  let knowledgeLocator: KnowledgeLocator | null = null
  if (body.knowledgeLocator != null && !requestedKnowledgeLocator) {
    return jsonError('knowledge_locator_invalid', 400)
  }
  if (requestedKnowledgeLocator) {
    try {
      knowledgeLocator = validateKnowledgeLocator({ locator: requestedKnowledgeLocator, allowedScopeIds })
    } catch (error) {
      if (error instanceof KnowledgeAccessError) return jsonError(error.code, error.status)
      throw error
    }
  } else {
    knowledgeLocator = resolveKnowledgeLocatorFromMessage({ message, allowedScopeIds })
  }
  if (knowledgeLocator?.appScopeId) {
    appScopeId = resolveRequestedAppScopeId(knowledgeLocator.appScopeId, allowedScopeIds)
  }
  const classRefs = parseClassRefs(body.classRefs)
  const kbProjectId = resolveKbProjectIdForChat({
    appScopeId,
    allowedScopeIds,
    classRefs,
    message,
  })
  const chatSessionId =
    typeof body.chatSessionId === 'string' && body.chatSessionId.trim()
      ? body.chatSessionId.trim()
      : null
  const sessionId = parseAgentSessionId(body.sessionId)

  if (typeof body.sessionId === 'string' && body.sessionId.trim() && !sessionId) {
    return jsonError('invalid_session_id', 400)
  }

  const priorMessages = chatSessionId
    ? await listRecentMessagesBySessionForToken({
        sessionId: chatSessionId,
        tokenId: tok.id,
        limit: 12,
      })
    : null

  let activeOpencodeSessionId = await resolveActiveOpencodeSessionForChat({
    requestedSessionId: sessionId,
    chatSessionId,
    tokenId: tok.id,
  })
  const continuity = resolveOpencodeChatContinuity({
    priorMessages,
    opencodeSessionId: activeOpencodeSessionId,
  })
  if (continuity === 'workbench_rehydrate') {
    activeOpencodeSessionId = null
  }

  if (chatSessionId) {
    const active = await getActiveOpencodeRequestForChatSession({
      chatSessionId,
      tokenId: tok.id,
    })
    if (active) {
      return jsonError('chat_session_busy', 409)
    }
    await beginKbTelemetryTurn(chatSessionId, tok.id, kbProjectId)
  }

  const telemetryCtx = chatSessionId ? { chatSessionId, apiTokenId: tok.id } : { apiTokenId: tok.id }
  const intentPlan = classifyOpencodeIntent(message, classRefs)
  if (chatSessionId) {
    void trackKbTurnMeta(
      {
        intent: intentPlan.intent,
        injectKnowledge: intentPlan.injectKnowledge,
        injectUrlDirective: intentPlan.injectUrlDirective,
        injectClassHint: intentPlan.injectClassHint,
      },
      telemetryCtx,
    )
  }

  const augmented = await augmentOpencodeMessage(
    message,
    appScopeId,
    allowedScopeIds,
    classRefs,
    telemetryCtx,
    {
      opencodeSessionId: activeOpencodeSessionId,
      continuity,
      priorMessages: priorMessages || [],
      knowledgeLocator,
    },
  )
  const opencodeMessage = augmented.text
  const presearchImages = augmented.presearchImages

  const runGeneration = chatSessionId ? beginChatAgentRun(chatSessionId) : 0

  const messageForAgent = opencodeMessage

  const recordId = await createOpencodeRequest({
    apiTokenId: tok.id,
    chatSessionId,
    appScopeId,
    module: resolveAppScopeModuleLabel(appScopeId, allowedScopeIds),
    classFqn: extractClassHintFromPrompt(message),
    userPrompt: message,
    modelName: await resolveAgentModelLabel(),
  })

  const queue: QueueItem[] = []
  let wake: (() => void) | null = null
  const pushQueue = (item: QueueItem) => {
    queue.push(item)
    wake?.()
    wake = null
  }

  let accumulated = ''
  let accumulatedReasoning = ''
  let accumulatedImages: OpencodeImageRef[] = []
  let opencodeSessionId: string | null = activeOpencodeSessionId
  let streamError: string | null = null
  let persisted = false
  let lastProgressAt = 0

  const maybeUpdateProgress = async () => {
    const now = Date.now()
    if (now - lastProgressAt < 800) return
    lastProgressAt = now
    try {
      await updateOpencodeRequestProgress({
        id: recordId,
        assistantOutput: accumulated || null,
        opencodeSessionId,
      })
    } catch {
      // ignore progress write failures
    }
  }

  const persist = async () => {
    if (persisted) return
    persisted = true
    const superseded = chatSessionId ? shouldAbortChatAgentRun(chatSessionId, runGeneration) : false
    const status = superseded ? 'canceled' : streamError ? 'failed' : 'done'
    try {
      const finished = await finishOpencodeRequestIfRunning({
        id: recordId,
        status,
        assistantOutput: accumulated || null,
        opencodeSessionId,
        error: superseded ? 'superseded' : streamError,
      })
      if (finished && chatSessionId && status !== 'canceled' && (accumulated.trim() || accumulatedReasoning.trim())) {
        await persistAssistantReply({
          chatSessionId,
          tokenId: tok.id,
          content: accumulated.trim(),
          agentSessionId: opencodeSessionId,
          images: accumulatedImages,
          appScopeId,
          interrupted: status === 'failed',
          reasoning: accumulatedReasoning,
          error: streamError,
        })
      }
    } catch {
      // keep stream response even if audit write fails
    }
    if (chatSessionId) {
      void finishKbTelemetryTurn(chatSessionId, {
        apiTokenId: tok.id,
        status: superseded ? 'canceled' : streamError ? 'failed' : 'done',
      })
    }
  }

  void (async () => {
    try {
      for await (const event of streamChat({
        message: messageForAgent,
        attachments,
        sessionId: activeOpencodeSessionId,
        chatSessionId,
        shouldCancel: () =>
          chatSessionId ? shouldAbortChatAgentRun(chatSessionId, runGeneration) : false,
      })) {
        if (event.type === 'error') {
          streamError = event.message
          break
        }
        pushQueue(event)
        if (event.type === 'session') {
          opencodeSessionId = event.sessionId
          if (chatSessionId && event.sessionId) {
            void bindOpencodeSessionToTrace(event.sessionId, chatSessionId, tok.id)
          }
          void maybeUpdateProgress()
        } else if (event.type === 'token') {
          accumulated += event.text
          if (chatSessionId) void trackKbOutputChars(chatSessionId, event.text.length)
          void maybeUpdateProgress()
        } else if (event.type === 'reasoning') {
          accumulatedReasoning += event.text
        } else if (event.type === 'image') {
          accumulatedImages = dedupeOpencodeImages([
            ...accumulatedImages,
            { path: event.path, mime: event.mime, alt: event.alt },
          ])
          void maybeUpdateProgress()
        } else if (event.type === 'done') {
          break
        }
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : 'unknown_error'
    } finally {
      await persist()
      if (streamError) pushQueue({ type: 'error', message: streamError })
      pushQueue({ type: 'close' })
    }
  })()

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // client disconnected
        }
      }

      const heartbeat = setInterval(() => {
        enqueue({ type: 'ping' })
      }, 1000)

      try {
        for (const img of presearchImages) {
          enqueue({ type: 'image', path: img.path, mime: img.mime, alt: img.alt })
        }

        while (true) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          const item = queue.shift()
          if (!item) continue
          if (item.type === 'close') break
          enqueue(item)
        }
      } finally {
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // ignore
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
