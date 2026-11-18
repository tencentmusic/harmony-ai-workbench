#!/usr/bin/env node
/**
 * 将 opencode_requests 中误标为 deepseek/* 的历史记录改回 codex/gpt-5.4-mini。
 * 用法：node scripts/backfill-opencode-model-to-gpt.mjs [dbPath] [targetModel]
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dbPath = process.argv[2] || path.join(root, 'prisma', 'data.prod.db')
const targetModel = process.argv[3] || 'sub2api/gpt-5.6-luna'

function sql(query) {
  return execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' }).trim()
}

console.log(`DB: ${dbPath}`)
console.log(`Target: ${targetModel}`)
console.log('\n==> before')
console.log(sql("SELECT model_name, COUNT(1) FROM opencode_requests WHERE model_name LIKE 'deepseek/%' GROUP BY model_name;") || '(none)')

const changed = sql(
  `UPDATE opencode_requests SET model_name = '${targetModel.replace(/'/g, "''")}' WHERE model_name LIKE 'deepseek/%'; SELECT changes();`,
)
console.log(`\n==> updated rows: ${changed}`)

const remaining = sql("SELECT COUNT(1) FROM opencode_requests WHERE model_name LIKE 'deepseek/%';")
console.log(`==> deepseek remaining: ${remaining}`)
