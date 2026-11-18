#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
process.chdir(repoRoot)

const { createTelemetryQueryClient } = await import(
  pathToFileURL(path.join(repoRoot, 'src/lib/kb-telemetry-store.ts')).href
)

const client = createTelemetryQueryClient()
const since = new Date(Date.now() - 7 * 86400000).toISOString()

const r1 = await client.query(
  `SELECT event_type, consumer, CAST(COUNT(*) AS INTEGER) AS n,
    CAST(SUM(CASE WHEN trace_id IS NULL OR trace_id = '' THEN 1 ELSE 0 END) AS INTEGER) AS no_trace
   FROM kb_telemetry_events
   WHERE ts >= ? AND event_type IN ('kb.graph_query', 'session.turn_closed')
   GROUP BY 1, 2 ORDER BY n DESC`,
  [since],
)
console.log('=== trace linkage by event ===')
console.table(r1.rows)

const r2 = await client.query(
  `SELECT tc.trace_id, tc.turn_id, tc.consumer,
    json_extract(tc.payload_json, '$.cohort') AS cohort,
    json_extract(tc.payload_json, '$.kb_context_served') AS kb,
    json_extract(tc.payload_json, '$.codegraph_calls') AS payload_cg_calls,
    json_extract(tc.payload_json, '$.codegraph_hits') AS payload_cg_hits,
    COALESCE(t.codegraph_calls, 0) AS join_cg_calls,
    COALESCE(t.codegraph_hits, 0) AS join_cg_hits
   FROM kb_telemetry_events tc
   LEFT JOIN (
     SELECT trace_id, turn_id,
       CAST(SUM(CASE WHEN event_type = 'kb.graph_query' THEN 1 ELSE 0 END) AS INTEGER) AS codegraph_calls,
       CAST(SUM(CASE WHEN event_type = 'kb.graph_query'
         AND (json_extract(payload_json, '$.hit') IN ('true', '1')
           OR CAST(json_extract(payload_json, '$.result_count') AS INTEGER) > 0)
         AND COALESCE(json_extract(payload_json, '$.error'), '') = ''
         THEN 1 ELSE 0 END) AS INTEGER) AS codegraph_hits
     FROM kb_telemetry_events WHERE ts >= ?
     GROUP BY trace_id, turn_id
   ) t ON tc.trace_id = t.trace_id AND tc.turn_id = t.turn_id
   WHERE tc.event_type = 'session.turn_closed' AND tc.ts >= ?
   ORDER BY tc.ts DESC`,
  [since, since],
)
console.log('=== turn_closed vs graph join ===')
console.table(r2.rows)

const r3 = await client.query(
  `SELECT ts, consumer, trace_id, turn_id,
    json_extract(payload_json, '$.tool_name') AS tool_name,
    json_extract(payload_json, '$.hit') AS hit
   FROM kb_telemetry_events
   WHERE ts >= ? AND event_type = 'kb.graph_query'
   ORDER BY ts DESC LIMIT 20`,
  [since],
)
console.log('=== recent graph_query events ===')
console.table(r3.rows)

const r4 = await client.query(
  `SELECT ts, trace_id, turn_id,
    json_extract(payload_json, '$.cohort') AS cohort,
    json_extract(payload_json, '$.raw_tool_calls') AS raw,
    json_extract(payload_json, '$.kb_context_served') AS kb,
    json_extract(payload_json, '$.duration_ms') AS dur
   FROM kb_telemetry_events
   WHERE ts >= ? AND event_type = 'session.turn_closed'
   ORDER BY ts ASC`,
  [since],
)
console.log('=== turn_closed timeline ===')
console.table(r4.rows)

const r5 = await client.query(
  `SELECT consumer,
    CAST(COUNT(*) AS INTEGER) AS n,
    CAST(SUM(CASE WHEN trace_id IS NULL OR trace_id = '' THEN 1 ELSE 0 END) AS INTEGER) AS no_trace
   FROM kb_telemetry_events
   WHERE ts >= ? AND event_type = 'kb.tool_call'
     AND COALESCE(json_extract(payload_json, '$.retrieval_mode'), 'raw_scan') = 'raw_scan'
   GROUP BY 1`,
  [since],
)
console.log('=== raw tool_call trace linkage ===')
console.table(r5.rows)

await client.end()
