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
  `
  SELECT json_extract(payload_json, '$.cohort') AS cohort, consumer, CAST(COUNT(*) AS INTEGER) AS turns,
    ROUND(AVG(CAST(json_extract(payload_json, '$.raw_tool_calls') AS REAL)), 2) AS avg_raw,
    ROUND(AVG(CAST(json_extract(payload_json, '$.tool_calls') AS REAL)), 2) AS avg_tools
  FROM kb_telemetry_events WHERE event_type='session.turn_closed' AND ts >= ?
  GROUP BY 1,2 ORDER BY turns DESC`,
  [since],
)
console.log('=== cohort ===')
console.table(r1.rows)

const r2 = await client.query(
  `
  SELECT event_type, consumer, CAST(COUNT(*) AS INTEGER) AS n
  FROM kb_telemetry_events WHERE ts >= ?
    AND COALESCE(feature_id, json_extract(payload_json, '$.feature_id'), '(unknown)') = '(unknown)'
  GROUP BY 1,2 ORDER BY n DESC`,
  [since],
)
console.log('=== unknown breakdown ===')
console.table(r2.rows)

await client.end()
