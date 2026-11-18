import crypto from 'crypto'

import { newTraceId } from '../lib/normalize-event.mjs'



const turns = new Map()



function cohortFromAcc(acc) {

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



function retrievalMixFromAcc(acc) {

  const mix = new Set()

  if (acc.kbContextServed > 0) mix.add('kb_pack')

  if (acc.codegraphHits > 0) mix.add('codegraph_index')

  if (acc.rawToolCalls > 0) mix.add('raw_scan')

  return [...mix]

}



export function createSessionContext(options = {}) {

  const traceId = options.traceId || newTraceId()

  const turnId = options.turnId || crypto.randomUUID()

  return { traceId, turnId }

}



export function getTurnAccumulator(traceId, turnId) {

  const key = `${traceId}::${turnId}`

  if (!turns.has(key)) {

    turns.set(key, {

      traceId,

      turnId,

      kbContextServed: 0,

      artifactReads: 0,

      toolCalls: 0,

      codegraphCalls: 0,

      codegraphHits: 0,

      rawToolCalls: 0,

      graphQueryChars: 0,

      outputChars: 0,

      featureIds: new Set(),

      startedAt: Date.now(),

    })

  }

  return turns.get(key)

}



export function recordContextServed(traceId, turnId, featureId) {

  const acc = getTurnAccumulator(traceId, turnId)

  acc.kbContextServed += 1

  if (featureId) acc.featureIds.add(featureId)

}



export function recordGraphQuery(traceId, turnId, options = {}) {

  const acc = getTurnAccumulator(traceId, turnId)

  acc.codegraphCalls += 1

  acc.toolCalls += 1

  acc.graphQueryChars += Number(options.responseChars || 0)

  if (options.hit) acc.codegraphHits += 1

}



export function recordArtifactRead(traceId, turnId) {

  getTurnAccumulator(traceId, turnId).artifactReads += 1

}



export function recordToolCall(traceId, turnId, options = {}) {

  const acc = getTurnAccumulator(traceId, turnId)

  acc.toolCalls += 1

  if (options.retrieval_mode === 'codegraph_index' || options.tool_family === 'codegraph') {

    acc.codegraphCalls += 1

    if (options.hit) acc.codegraphHits += 1

  } else if (options.retrieval_mode === 'raw_scan' || options.tool_family === 'agent_native') {

    acc.rawToolCalls += 1

  }

}



export function recordOutputChars(traceId, turnId, chars) {

  getTurnAccumulator(traceId, turnId).outputChars += chars

}



export function consumeTurnSummary(traceId, turnId, options = {}) {

  const key = `${traceId}::${turnId}`

  const acc = turns.get(key)

  if (!acc) return null

  turns.delete(key)

  const retrieval_mix = retrievalMixFromAcc(acc)

  return {

    cohort: cohortFromAcc(acc),

    kb_context_served: acc.kbContextServed,

    codegraph_calls: acc.codegraphCalls,

    codegraph_hits: acc.codegraphHits,

    raw_tool_calls: acc.rawToolCalls,

    artifact_reads: acc.artifactReads,

    tool_calls: acc.toolCalls,

    graph_query_chars: acc.graphQueryChars,

    output_chars: acc.outputChars,

    feature_ids: [...acc.featureIds],

    retrieval_mix,

    duration_ms: Date.now() - acc.startedAt,

    status: options.status || 'done',

    ...options.extra,

  }

}



export function clearTurn(traceId, turnId) {

  turns.delete(`${traceId}::${turnId}`)

}


