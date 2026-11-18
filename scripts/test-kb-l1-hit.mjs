#!/usr/bin/env node
/** 本地诊断：fxwiki L1 命中 + context_served 是否写入 ingest */
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()

const msg = process.argv[2] || '虚拟开播的 Android 和 Harmony 入口是什么？'
const projectId = process.argv[3] || 'kugou-live'
const { beginKbTelemetryTurn } = await import('../src/lib/kb-telemetry-bridge.ts')
const { buildOpencodeKnowledgeBundle } = await import('../src/lib/opencode/opencode-knowledge-context.ts')

await beginKbTelemetryTurn('diag-session', 'tok-diag')
const bundle = await buildOpencodeKnowledgeBundle(msg, [], {
  chatSessionId: 'diag-session',
  apiTokenId: 'tok-diag',
}, { projectId })
console.log('bundle hit', bundle.meta.hit, bundle.meta.feature_id, bundle.meta.match_by)
console.log(bundle.directive.slice(0, 2000))
await new Promise((resolve) => setTimeout(resolve, 300))

const port = process.env.WORKBENCH_PORT || process.env.PORT || '3100'
const queryBase = process.env.KB_TELEMETRY_QUERY_URL || `http://127.0.0.1:${port}/api/kb-telemetry/v1`
const response = await fetch(`${queryBase}/stats/summary?days=1`)
const summary = await response.json()
console.log('daily L1 context_served', summary.daily?.[0]?.context_served ?? 'n/a')
console.log('totals', summary.totals?.filter((item) => item.event_type === 'kb.context_served'))
