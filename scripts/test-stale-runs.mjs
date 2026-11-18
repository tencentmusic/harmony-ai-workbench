import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const db = path.resolve(root, '../prisma/data.prod.db')

function sql(query) {
  return spawnSync('sqlite3', [db, query], { encoding: 'utf8' }).stdout.trim()
}

console.log('running before:', sql("SELECT COUNT(*) FROM opencode_requests WHERE status='running';"))

spawnSync(
  'sqlite3',
  [
    db,
    `UPDATE opencode_requests
     SET status = 'failed', error = 'stale_run', finished_at = datetime('now')
     WHERE status = 'running'
       AND (
         datetime(created_at) <= datetime('now', '-15 minutes')
         OR (
           (assistant_output IS NULL OR trim(assistant_output) = '')
           AND datetime(created_at) <= datetime('now', '-2 minutes')
         )
       );`,
  ],
  { encoding: 'utf8' },
)

console.log('running after:', sql("SELECT COUNT(*) FROM opencode_requests WHERE status='running';"))
console.log('recent stale_run:')
spawnSync(
  'sqlite3',
  [db, "SELECT id, status, error, length(assistant_output) FROM opencode_requests WHERE error='stale_run' ORDER BY created_at DESC LIMIT 5;"],
  { stdio: 'inherit' },
)
