#!/usr/bin/env node
/**
 * 清理工台 kb_telemetry_events 中的测试 / benchmark 数据
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const TEST_CONSUMERS = ['test', 'benchmark', 'mcp-direct']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
process.chdir(repoRoot)

const { createTelemetryQueryClient } = await import(
  pathToFileURL(path.join(repoRoot, 'src/lib/kb-telemetry-store.ts')).href
)

const client = createTelemetryQueryClient()
const placeholders = TEST_CONSUMERS.map(() => '?').join(', ')

const preview = await client.query(
  `SELECT consumer, event_type, CAST(COUNT(*) AS INTEGER) AS n
   FROM kb_telemetry_events
   WHERE consumer IN (${placeholders})
   GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
  TEST_CONSUMERS,
)
console.log('将删除以下 consumer 的事件:', TEST_CONSUMERS.join(', '))
console.table(preview.rows)

if (dryRun) {
  console.log('(--dry-run，未执行删除)')
  await client.end()
  process.exit(0)
}

const res = await client.query(
  `DELETE FROM kb_telemetry_events WHERE consumer IN (${placeholders})`,
  TEST_CONSUMERS,
)
console.log(`已删除 test consumer ${res.rowCount} 条`)
await client.end()
