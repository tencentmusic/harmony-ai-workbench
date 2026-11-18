#!/usr/bin/env node
/**
 * 源码同步 Worker：消费 data/repo-sync/queue 中的任务
 *
 * 用法：
 *   npm run repo-sync:worker          # 常驻
 *   npm run repo-sync:worker -- --once # 处理一条后退出
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkbenchEnv } from '../../scripts/render-opencode-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(__dirname, '../..'))
loadWorkbenchEnv()

const once = process.argv.includes('--once')
const intervalArg = process.argv.find((a) => a.startsWith('--interval='))
const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) : 5000

const { runRepoSyncWorkerLoop } = await import(
  '../../src/server/modules/repo-sync/worker-public.ts'
)

console.log(`[harmony-workbench-repo-sync-worker] start once=${once} interval=${intervalMs}ms`)
await runRepoSyncWorkerLoop({
  once,
  intervalMs,
  onTick: (info) => {
    if (!info.processed) return
    if (info.error) console.error(`[harmony-workbench-repo-sync-worker] failed runId=${info.runId}: ${info.error}`)
  },
})
