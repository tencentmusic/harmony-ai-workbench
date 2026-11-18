import crypto from 'node:crypto'

import fs from 'node:fs'

import path from 'node:path'
import { resolveKnowledgeBaseRoot } from '../server/platform/knowledge-base-root'

import { bindHostSession } from '@/lib/kb-telemetry-trace-registry'
import { insertKbTelemetryEvents } from '@/lib/kb-telemetry-store'



type TurnContext = { traceId: string; turnId: string; projectId?: string }

type TurnAccumulator = TurnContext & {

  startedAt: number

  kbContextServed: number

  codegraphCalls: number
  codegraphHits: number

  rawToolCalls: number

  artifactReads: number

  toolCalls: number

  outputChars: number

  featureIds: Set<string>

  intent?: string

}



const sessionByChat = new Map<string, TurnContext>()

const turnStats = new Map<string, TurnAccumulator>()



function turnKey(traceId: string, turnId: string) {

  return `${traceId}::${turnId}`

}



function isEnabled() {

  return String(process.env.KB_TELEMETRY_ENABLED ?? '1') !== '0'

}



function cohortFromAcc(acc: TurnAccumulator) {

  const hasKb = acc.kbContextServed > 0

  const hasCg = acc.codegraphHits > 0

  const hasRaw = acc.rawToolCalls > 0

  if (hasKb && !hasCg && !hasRaw) return 'kb_only'

  if (hasKb && hasCg) return 'kb_plus_codegraph'

  if (!hasKb && hasCg) return 'codegraph_only'

  if (hasRaw && !hasKb && !hasCg) return 'raw_scan'

  if (hasKb && hasRaw && !hasCg) return 'kb_mixed'

  return 'kb_off'

}



function retrievalMixFromAcc(acc: TurnAccumulator) {

  const mix = new Set<string>()

  if (acc.kbContextServed > 0) mix.add('kb_pack')

  if (acc.codegraphHits > 0) mix.add('codegraph_index')

  if (acc.rawToolCalls > 0) mix.add('raw_scan')

  return [...mix]

}



function readKbVersionMeta(projectId?: string) {

  const kbRoot = resolveKnowledgeBaseRoot()

  if (!kbRoot) {

    return { project_id: projectId || 'unknown', kb_version: 'unknown', kb_root_hash: 'unknown' }

  }

  try {

    const releaseDir = path.join(kbRoot, 'reports', 'release')

    const files = fs

      .readdirSync(releaseDir)

      .filter((f) => f.startsWith('freeze-manifest-') && f.endsWith('.json'))

      .sort()

    if (!files.length) throw new Error('no manifest')

    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, files[files.length - 1]!), 'utf8'))

    const hash = crypto

      .createHash('sha256')

      .update(JSON.stringify(manifest.file_hashes || {}))

      .digest('hex')

      .slice(0, 16)

    return {

      project_id: projectId || manifest.project_id || 'unknown',

      kb_version: manifest.knowledge_version || 'unknown',

      kb_root_hash: hash,

    }

  } catch {

    return { project_id: projectId || 'unknown', kb_version: 'unknown', kb_root_hash: 'unknown' }

  }

}



function buildEvent(

  partial: Record<string, unknown>,

  options: {

    traceId?: string

    turnId?: string

    apiTokenId?: string

    consumer?: string

    projectId?: string

  } = {},

) {

  const kb = readKbVersionMeta(options.projectId)

  const userHash = options.apiTokenId

    ? crypto.createHash('sha256').update(options.apiTokenId).digest('hex').slice(0, 16)

    : null

  const payload = (partial.payload as Record<string, unknown>) || {}

  const featureId =

    (partial.feature_id as string | undefined) || (payload.feature_id as string | undefined) || null



  return {

    schema_version: '1.1',

    event_id: crypto.randomUUID(),

    event_type: partial.event_type,

    ts: new Date().toISOString(),

    feature_id: featureId,

    session: {

      trace_id: (partial.session as { trace_id?: string } | undefined)?.trace_id || options.traceId || null,

      turn_id: (partial.session as { turn_id?: string } | undefined)?.turn_id || options.turnId || null,

      parent_event_id: null,

    },

    actor: {

      consumer: options.consumer || process.env.KB_TELEMETRY_CONSUMER || 'workbench-bff',

      user_hash: userHash,

      api_token_id: options.apiTokenId || null,

    },

    kb,

    payload,

  }

}



async function postEvents(events: Record<string, unknown>[]) {

  if (!events.length || !isEnabled()) return

  await insertKbTelemetryEvents(events)

}



function getTurnAcc(traceId?: string, turnId?: string) {

  if (!traceId || !turnId) return null

  const key = turnKey(traceId, turnId)

  if (!turnStats.has(key)) {

    turnStats.set(key, {

      traceId,

      turnId,

      startedAt: Date.now(),

      kbContextServed: 0,

      codegraphCalls: 0,
      codegraphHits: 0,

      rawToolCalls: 0,

      artifactReads: 0,

      toolCalls: 0,

      outputChars: 0,

      featureIds: new Set<string>(),

    })

  }

  return turnStats.get(key)!

}



function telemetryOpts(options: { chatSessionId?: string; apiTokenId?: string } = {}) {

  const ctx = options.chatSessionId ? sessionByChat.get(options.chatSessionId) : undefined

  return {

    traceId: ctx?.traceId,

    turnId: ctx?.turnId,

    apiTokenId: options.apiTokenId,

    projectId: ctx?.projectId,

  }

}



export function getKbTelemetryTrace(chatSessionId: string) {

  return sessionByChat.get(chatSessionId) || null

}



export async function bindOpencodeSessionToTrace(

  opencodeSessionId: string,

  chatSessionId: string,

  apiTokenId?: string,

) {

  if (!isEnabled()) return

  const ctx = sessionByChat.get(chatSessionId)

  if (!ctx || !opencodeSessionId) return

  const acc = getTurnAcc(ctx.traceId, ctx.turnId)

  const featureIds = acc ? [...acc.featureIds] : []

  bindHostSession(opencodeSessionId, {
    traceId: ctx.traceId,
    turnId: ctx.turnId,
    consumer: process.env.KB_TELEMETRY_CONSUMER || 'workbench-bff',
    chatSessionId,
    featureId: featureIds[0] || null,
    featureIds,
    apiTokenId: apiTokenId || null,
  })

}



export async function beginKbTelemetryTurn(
  chatSessionId: string,
  _apiTokenId?: string,
  projectId?: string,
) {

  if (!isEnabled()) return null

  const ctx = {
    traceId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    ...(projectId ? { projectId } : {}),
  }

  sessionByChat.set(chatSessionId, ctx)

  getTurnAcc(ctx.traceId, ctx.turnId)

  return ctx

}



export async function trackKbTurnMeta(

  meta: {

    intent: string

    injectKnowledge: boolean

    injectUrlDirective: boolean

    injectClassHint: boolean

  },

  options: { chatSessionId?: string; apiTokenId?: string } = {},

) {

  if (!isEnabled()) return

  const opts = telemetryOpts(options)

  const acc = getTurnAcc(opts.traceId, opts.turnId)

  if (acc) acc.intent = meta.intent
  // intent 已写入 turn_closed；不再伪造 kb.match_attempt，避免 ROI 按功能统计出现 (unknown)
}



export async function trackKbMatchAttempt(

  partial: {

    hit: boolean

    feature_id?: string

    match_by?: string

    match_candidates?: string[]

  },

  options: { chatSessionId?: string; apiTokenId?: string } = {},

) {

  if (!isEnabled()) return

  const opts = telemetryOpts(options)

  const event = buildEvent(

    {

      event_type: 'kb.match_attempt',

      feature_id: partial.feature_id || undefined,

      payload: {

        hit: partial.hit,

        feature_id: partial.feature_id || null,

        match_by: partial.match_by || null,

        match_candidates: partial.match_candidates || [],

        delivery: 'bff_prompt_inject',

        retrieval_mode: 'kb_pack',

        tool_family: 'feature_context',

      },

    },

    opts,

  )

  await postEvents([event]).catch(() => {})

}



export async function trackKbContextServed(

  meta: {

    hit: boolean

    feature_id?: string

    match_by?: string

    match_candidates?: string[]

    artifacts?: string[]

    inject_chars?: number

    intent?: string

    inject_mode?: 'full' | 'session_continue'

    retrieval_mode?: 'kb_pack'

  },

  options: { chatSessionId?: string; apiTokenId?: string } = {},

) {

  if (!isEnabled() || !meta.hit) return

  const opts = telemetryOpts(options)

  const acc = getTurnAcc(opts.traceId, opts.turnId)

  if (acc) {

    acc.kbContextServed += 1

    if (meta.feature_id) acc.featureIds.add(meta.feature_id)

  }



  const basePayload = {

    feature_id: meta.feature_id,

    match_by: meta.match_by,

    match_candidates: meta.match_candidates || [],

    delivery: 'bff_prompt_inject',

    retrieval_mode: 'kb_pack',

    tool_family: 'feature_context',

    substitute_level: 'L1',

    artifacts: meta.artifacts || [],

    inject_chars: meta.inject_chars || 0,

    intent: meta.intent || 'call_chain',

    inject_mode: meta.inject_mode || 'full',

  }

  await postEvents([

    buildEvent(

      {

        event_type: 'kb.context_served',

        feature_id: meta.feature_id,

        payload: basePayload,

      },

      opts,

    ),

  ]).catch(() => {})

}



export async function trackKbOutputChars(chatSessionId: string, chars: number) {

  if (!isEnabled() || !chars) return

  const ctx = sessionByChat.get(chatSessionId)

  if (!ctx) return

  const acc = getTurnAcc(ctx.traceId, ctx.turnId)

  if (acc) acc.outputChars += chars

}



export async function finishKbTelemetryTurn(

  chatSessionId: string,

  options: { apiTokenId?: string; status?: string } = {},

) {

  if (!isEnabled()) return

  const ctx = sessionByChat.get(chatSessionId)

  if (!ctx) return

  const acc = getTurnAcc(ctx.traceId, ctx.turnId)

  const summary = acc

    ? {

        cohort: cohortFromAcc(acc),

        kb_context_served: acc.kbContextServed,

        codegraph_calls: acc.codegraphCalls,
        codegraph_hits: acc.codegraphHits,

        raw_tool_calls: acc.rawToolCalls,

        artifact_reads: acc.artifactReads,

        tool_calls: acc.toolCalls,

        output_chars: acc.outputChars,

        feature_ids: [...acc.featureIds],

        retrieval_mix: retrievalMixFromAcc(acc),

        intent: acc.intent || null,

        duration_ms: Date.now() - acc.startedAt,

        status: options.status || 'done',

      }

    : {

        cohort: 'kb_off',

        kb_context_served: 0,

        codegraph_calls: 0,
        codegraph_hits: 0,

        raw_tool_calls: 0,

        artifact_reads: 0,

        tool_calls: 0,

        output_chars: 0,

        feature_ids: [],

        retrieval_mix: [],

        duration_ms: 0,

        status: options.status || 'done',

      }



  const event = buildEvent(

    {

      event_type: 'session.turn_closed',

      feature_id: acc && acc.featureIds.size ? [...acc.featureIds][0] : undefined,

      payload: summary,

    },

    { ...ctx, apiTokenId: options.apiTokenId },

  )



  await postEvents([event]).catch(() => {})

  turnStats.delete(turnKey(ctx.traceId, ctx.turnId))

  sessionByChat.delete(chatSessionId)

}



export async function isKbTelemetryEnabled() {

  return isEnabled()

}


