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
const { buildStatsSummary } = await import(
  pathToFileURL(path.join(repoRoot, 'src/lib/kb-telemetry-aggregates.ts')).href
)

try {
  const client = createTelemetryQueryClient()
  const summary = await buildStatsSummary(client, 7)
  console.log('schema_version:', summary.schema_version)
  console.log('KPI:', summary.kpi)
  console.log('Cohort:')
  console.table(summary.cohort)
  await client.end()
} catch (err) {
  console.error('verify-kpi-aggregates failed (local DB may be unavailable):', err?.message || err)
  process.exit(1)
}
