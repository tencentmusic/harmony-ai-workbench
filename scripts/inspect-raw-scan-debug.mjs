#!/usr/bin/env node
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
process.chdir(repoRoot)
loadWorkbenchEnv()

const { createTelemetryQueryClient } = await import(
  pathToFileURL(path.join(repoRoot, 'src/lib/kb-telemetry-store.ts')).href
)
const { buildStatsSummary } = await import(
  pathToFileURL(path.join(repoRoot, 'src/lib/kb-telemetry-aggregates.ts')).href
)

const client = createTelemetryQueryClient()
const dash = await buildStatsSummary(client, 7)

console.log('=== dashboard daily (看板口径) ===')
console.log(JSON.stringify(dash.daily, null, 2))

const tools = await client.query(`
  SELECT strftime('%Y-%m-%d', datetime(ts, '+8 hours')) as day,
    COALESCE(json_extract(payload_json,'$.tool_name'), '(none)') as tool_name,
    COALESCE(json_extract(payload_json,'$.retrieval_mode'), '(none)') as mode,
    consumer,
    COUNT(*) as c
  FROM kb_telemetry_events
  WHERE event_type='kb.tool_call'
    AND ts >= datetime('now', '-2 days')
    AND consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')
  GROUP BY 1,2,3,4
  ORDER BY day DESC, c DESC
`)
console.log('=== kb.tool_call (近2天) ===')
console.log(JSON.stringify(tools.rows, null, 2))

const bridgeEvents = await client.query(`
  SELECT strftime('%Y-%m-%d', datetime(ts, '+8 hours')) as day, consumer, event_type, COUNT(*) c
  FROM kb_telemetry_events
  WHERE consumer IN ('opencode-bridge', 'workbench-bff', 'opencode-mcp')
    AND ts >= datetime('now', '-2 days')
  GROUP BY 1,2,3 ORDER BY 1 DESC, c DESC
`)
console.log('=== consumer breakdown ===')
console.log(JSON.stringify(bridgeEvents.rows, null, 2))

const latest = await client.query(`
  SELECT datetime(ts, '+8 hours') as ts_cst, event_type, consumer,
    json_extract(payload_json,'$.tool_name') as tool_name,
    json_extract(payload_json,'$.retrieval_mode') as mode
  FROM kb_telemetry_events
  WHERE event_type='kb.tool_call'
  ORDER BY ts DESC LIMIT 10
`)
console.log('=== latest kb.tool_call ===')
console.log(JSON.stringify(latest.rows, null, 2))

const turnClosed = await client.query(`
  SELECT strftime('%Y-%m-%d', datetime(ts, '+8 hours')) as day,
    CAST(json_extract(payload_json, '$.raw_tool_calls') AS INTEGER) as raw_tool_calls,
    CAST(json_extract(payload_json, '$.codegraph_calls') AS INTEGER) as codegraph_calls,
    json_extract(payload_json, '$.cohort') as cohort,
    COUNT(*) as n
  FROM kb_telemetry_events
  WHERE event_type = 'session.turn_closed'
    AND ts >= datetime('now', '-2 days')
    AND consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')
  GROUP BY 1, 2, 3, 4
  ORDER BY day DESC, n DESC
`)
console.log('=== turn_closed raw_tool_calls distribution ===')
console.log(JSON.stringify(turnClosed.rows, null, 2))

const todayDetail = await client.query(`
  SELECT datetime(ts, '+8 hours') as ts_cst, event_type, consumer,
    json_extract(payload_json, '$.tool_name') as tool_name,
    json_extract(payload_json, '$.cohort') as cohort,
    json_extract(payload_json, '$.intent') as intent
  FROM kb_telemetry_events
  WHERE date(datetime(ts, '+8 hours')) = date(datetime('now', '+8 hours'))
    AND consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')
  ORDER BY ts DESC
  LIMIT 40
`)
console.log('=== today events (latest 40) ===')
console.log(JSON.stringify(todayDetail.rows, null, 2))

const intentToday = await client.query(`
  SELECT json_extract(payload_json, '$.intent') as intent, COUNT(*) as n
  FROM kb_telemetry_events
  WHERE event_type = 'session.turn_closed'
    AND date(datetime(ts, '+8 hours')) = date(datetime('now', '+8 hours'))
  GROUP BY 1
  ORDER BY n DESC
`)
console.log('=== today intent distribution ===')
console.log(JSON.stringify(intentToday.rows, null, 2))

await client.end()
