#!/usr/bin/env node

import assert from 'assert'

import { classifyArtifactPath, classifyMcpTool, substituteLevel, canonicalAgentToolName } from '../../packages/kb-telemetry/lib/path-classifier.mjs'

import { normalizeEvent } from '../../packages/kb-telemetry/lib/normalize-event.mjs'

import { emit, flush, createSessionContext, emitTurnClosed } from '../../packages/kb-telemetry/client/index.mjs'

import { trackMcpToolCall } from '../../packages/kb-telemetry/adapters/mcp-middleware.mjs'



process.env.KB_TELEMETRY_ENABLED = '1'



const kb = classifyArtifactPath('team-knowledge/wiki/features/example/implementation.md')

assert.equal(kb.path_bucket, 'harmony-kb')

const fxwiki = classifyArtifactPath('fxwiki/android_wiki/wiki/features/账号/README.md')
assert.equal(fxwiki.path_bucket, 'harmony-kb')

const harmonyAbs = classifyArtifactPath('C:/AndroidProject/hmkugou/featrue/demo/Page.ets')

assert.equal(harmonyAbs.path_bucket, 'harmony-src')
assert.match(harmonyAbs.artifact_path, /^harmony-src\//)


const fc = classifyMcpTool('get_feature_context')
assert.equal(fc.tool_family, 'feature_context')

const fxwikiSearch = classifyMcpTool('kb_knowledge_search')
assert.equal(fxwikiSearch.retrieval_mode, 'kb_pack')

const cg = classifyMcpTool('kb_codegraph_search')
assert.equal(cg.tool_family, 'codegraph')

assert.equal(substituteLevel('kb_pack'), 'L1')

assert.equal(canonicalAgentToolName('harmony-kb-mcp_kb_codegraph_search'), 'kb_codegraph_search')

assert.equal(canonicalAgentToolName('kb_codegraph_search'), 'kb_codegraph_search')



const ev = normalizeEvent({

  event_type: 'kb.context_served',

  payload: { feature_id: 'ktv.song.search', delivery: 'bff_prompt_inject', retrieval_mode: 'kb_pack' },

})

assert.equal(ev.schema_version, '1.1')

assert.ok(ev.kb.kb_version)



const ctx = createSessionContext()

emit(

  {

    event_type: 'kb.context_served',

    session: { trace_id: ctx.traceId, turn_id: ctx.turnId },

    payload: {

      feature_id: 'ktv.song.search',

      match_by: 'feature_id',

      delivery: 'bff_prompt_inject',

      retrieval_mode: 'kb_pack',

      inject_chars: 100,

    },

  },

  { consumer: 'test', traceId: ctx.traceId, turnId: ctx.turnId },

)



await trackMcpToolCall(
  'kb_codegraph_search',
  { query: 'SearchSongFragment' },
  { hits: [{ node: { name: 'SearchSongFragment' } }] },
  { consumer: 'test', traceId: ctx.traceId, turnId: ctx.turnId },
)

console.log('telemetry self-test ok (schema 1.1 + graph_query, classifier only — 网络写入请用工台 API)')


