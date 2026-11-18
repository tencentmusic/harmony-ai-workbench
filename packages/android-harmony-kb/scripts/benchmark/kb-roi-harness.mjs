#!/usr/bin/env node
/**
 * KB ROI 基准集：模拟 L1/L2/L3 三类事件并写入 telemetry
 */
import { createSessionContext, emit, flush, emitTurnClosed } from '../../packages/kb-telemetry/client/index.mjs'
import { trackMcpContextServed, trackMcpToolCall } from '../../packages/kb-telemetry/adapters/mcp-middleware.mjs'

process.env.KB_TELEMETRY_ENABLED = '1'
process.env.KB_TELEMETRY_CONSUMER = 'benchmark'

const scenarios = [
  {
    name: 'kb_only',
    async run(ctx) {
      emit(
        {
          event_type: 'kb.context_served',
          session: { trace_id: ctx.traceId, turn_id: ctx.turnId },
          payload: {
            feature_id: 'ktv.song.search',
            delivery: 'bff_prompt_inject',
            retrieval_mode: 'kb_pack',
            tool_family: 'feature_context',
            substitute_level: 'L1',
            inject_chars: 4200,
          },
        },
        { consumer: 'benchmark', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      await emitTurnClosed({ traceId: ctx.traceId, turnId: ctx.turnId, status: 'done', consumer: 'benchmark' })
    },
  },
  {
    name: 'kb_plus_codegraph',
    async run(ctx) {
      emit(
        {
          event_type: 'kb.context_served',
          session: { trace_id: ctx.traceId, turn_id: ctx.turnId },
          payload: {
            feature_id: 'ktv.song.search',
            delivery: 'bff_prompt_inject',
            retrieval_mode: 'kb_pack',
            substitute_level: 'L1',
            inject_chars: 3000,
          },
        },
        { consumer: 'benchmark', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      await trackMcpToolCall(
        'kb_codegraph_callers',
        { symbol: 'SearchSongFragment', platform: 'android' },
        { callers: [{ name: 'SongMainFragment' }], symbol: 'SearchSongFragment' },
        { consumer: 'benchmark', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      await emitTurnClosed({ traceId: ctx.traceId, turnId: ctx.turnId, status: 'done', consumer: 'benchmark' })
    },
  },
  {
    name: 'raw_scan',
    async run(ctx) {
      emit(
        {
          event_type: 'kb.tool_call',
          session: { trace_id: ctx.traceId, turn_id: ctx.turnId },
          payload: {
            tool_name: 'grep',
            tool_family: 'agent_native',
            retrieval_mode: 'raw_scan',
            delivery: 'agent_native',
            substitute_level: 'L3',
          },
        },
        { consumer: 'benchmark', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      emit(
        {
          event_type: 'kb.tool_call',
          session: { trace_id: ctx.traceId, turn_id: ctx.turnId },
          payload: {
            tool_name: 'read',
            tool_family: 'agent_native',
            retrieval_mode: 'raw_scan',
            delivery: 'agent_native',
            substitute_level: 'L3',
          },
        },
        { consumer: 'benchmark', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      await emitTurnClosed({ traceId: ctx.traceId, turnId: ctx.turnId, status: 'done', consumer: 'benchmark' })
    },
  },
  {
    name: 'mcp_feature_context',
    async run(ctx) {
      await trackMcpContextServed(
        { feature_id: 'ktv.song.main', project_id: 'kugou-music' },
        { feature_id: 'ktv.song.main', project_id: 'kugou-music', title: '唱-我要唱', citations: [] },
        { consumer: 'mcp-direct', traceId: ctx.traceId, turnId: ctx.turnId },
      )
      await emitTurnClosed({ traceId: ctx.traceId, turnId: ctx.turnId, status: 'done', consumer: 'mcp-direct' })
    },
  },
]

for (const scenario of scenarios) {
  const ctx = createSessionContext()
  console.log(`benchmark scenario: ${scenario.name}`)
  await scenario.run(ctx)
}

await flush()
console.log('kb-roi benchmark events emitted; check GET /v1/stats/summary?days=7')
