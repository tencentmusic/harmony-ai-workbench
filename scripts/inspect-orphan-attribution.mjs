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

const r = await client.query(
  `SELECT tc2.trace_id, tc2.turn_id, tc2.ts AS turn_end,
    json_extract(tc2.payload_json, '$.duration_ms') AS dur,
    datetime(tc2.ts, '-' || CAST((COALESCE(CAST(json_extract(tc2.payload_json, '$.duration_ms') AS INTEGER), 600000) + 120000) / 1000 AS TEXT) || ' seconds') AS win_start,
    CAST(COUNT(g.id) AS INTEGER) AS orphan_graphs
   FROM kb_telemetry_events tc2
   JOIN kb_telemetry_events g ON
     g.event_type = 'kb.graph_query'
     AND g.consumer = 'opencode-mcp'
     AND (g.trace_id IS NULL OR g.trace_id = '')
     AND g.ts <= tc2.ts
     AND g.ts >= datetime(
       tc2.ts,
       '-' || CAST((COALESCE(CAST(json_extract(tc2.payload_json, '$.duration_ms') AS INTEGER), 600000) + 120000) / 1000 AS TEXT) || ' seconds'
     )
   WHERE tc2.ts >= ? AND tc2.event_type = 'session.turn_closed'
   GROUP BY tc2.trace_id, tc2.turn_id
   ORDER BY tc2.ts`,
  [since],
)
console.table(r.rows)
await client.end()
