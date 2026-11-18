import { emit, flush } from '../client/index.mjs'

import { classifyMcpTool, substituteLevel, canonicalAgentToolName } from '../lib/path-classifier.mjs'
import { graphQueryHitFields } from '../lib/graph-query-hit.mjs'



function responseSize(result) {

  try {

    return JSON.stringify(result ?? {}).length

  } catch {

    return 0

  }

}



export async function trackMcpContextServed(args, pack, options = {}) {
  const hit = !pack?.error
  const toolName = canonicalAgentToolName(options.toolName || 'get_feature_context')
  const cls = classifyMcpTool(toolName)
  const auditMeta = {
    mcp_token_id: options.apiTokenId || null,
    person_code: options.personCode || null,
    person_name: options.personName || null,
    mcp_session_id: options.mcpSessionId || options.traceId || null,
  }

  emit(
    {
      event_type: 'kb.match_attempt',
      payload: {
        feature_id: args.feature_id,
        project_id: args.project_id || 'kugou-music',
        hit,
        match_by: 'feature_id',
        delivery: cls.delivery,
        tool_family: cls.tool_family,
        retrieval_mode: cls.retrieval_mode,
        tool_name: toolName,
        error: pack?.error || null,
        ...auditMeta,
      },
    },
    { consumer: options.consumer || 'mcp-direct', ...options },
  )

  if (!hit) return null

  const artifacts = Array.isArray(pack.citations) ? pack.citations : []
  return emit(
    {
      event_type: 'kb.context_served',
      feature_id: pack.feature_id,
      payload: {
        feature_id: pack.feature_id,
        project_id: pack.project_id,
        match_by: 'feature_id',
        match_candidates: [args.feature_id],
        delivery: cls.delivery,
        tool_family: cls.tool_family,
        retrieval_mode: cls.retrieval_mode,
        tool_name: toolName,
        substitute_level: substituteLevel(cls.retrieval_mode),
        artifacts,
        inject_chars: JSON.stringify(pack).length,
        intent: 'feature_context',
        title: pack.title || null,
        ...auditMeta,
      },
    },
    { consumer: options.consumer || 'mcp-direct', ...options },
  )
}



export async function trackMcpToolCall(toolName, args, result, options = {}) {
  const cls = classifyMcpTool(toolName)
  const size = responseSize(result)
  const isCodegraph = cls.tool_family === 'codegraph'

  let traceId = options.traceId
  let turnId = options.turnId
  if ((!traceId || !turnId) && options.consumer !== 'test') {
    const { resolveTelemetryTrace } = await import('../lib/resolve-telemetry-trace.mjs')
    const bound = resolveTelemetryTrace(options)
    if (bound) {
      traceId = bound.traceId
      turnId = bound.turnId
    }
  }

  const emitOptions = { ...options, traceId, turnId }

  const basePayload = graphQueryHitFields(result, {
    tool_name: canonicalAgentToolName(toolName),
    tool_family: cls.tool_family,
    retrieval_mode: cls.retrieval_mode,
    delivery: cls.delivery,
    substitute_level: substituteLevel(cls.retrieval_mode),
    query_symbol: args?.symbol || args?.query || null,
    platform: args?.platform || null,
    feature_id: args?.feature_id || null,
    response_chars: size,
    latency_ms: Number.isFinite(options.latencyMs) ? Math.max(0, Math.round(options.latencyMs)) : null,
    mcp_token_id: options.apiTokenId || null,
    person_code: options.personCode || null,
    person_name: options.personName || null,
    mcp_session_id: options.mcpSessionId || options.traceId || null,
  })

  if (isCodegraph) {
    emit(
      {
        event_type: 'kb.graph_query',
        payload: basePayload,
      },
      { consumer: emitOptions.consumer || 'mcp-direct', ...emitOptions },
    )

    if (basePayload.hit) {
      emit(
        {
          event_type: 'kb.context_served',
          feature_id: args?.feature_id || null,
          payload: {
            ...basePayload,
            match_by: 'codegraph_index',
            inject_chars: size,
            intent: toolName.replace('kb_codegraph_', ''),
          },
        },
        { consumer: emitOptions.consumer || 'mcp-direct', ...emitOptions },
      )
    }
  } else {
    emit(
      {
        event_type: 'kb.tool_call',
        payload: basePayload,
      },
      { consumer: emitOptions.consumer || 'mcp-direct', ...emitOptions },
    )
  }

  await flush({ env: options.env })
  return basePayload
}



export { emitTurnClosed } from '../client/index.mjs'


