#!/usr/bin/env node
/**
 * kb-sync 统一入口 — Webhook / CI / 本地 共用
 *
 *   node scripts/kb-sync/run.mjs l2 --check-only
 *   node scripts/kb-sync/run.mjs l2 --sync
 */
import { pushL2ReportToWorkbench } from '../lib/push-l2-report-to-workbench.mjs'
import { runCodegraphHealthCheck } from '../lib/codegraph-health-check.mjs'

const domain = process.argv[2] || 'l2'
const checkOnly = process.argv.includes('--check-only')
const sync = process.argv.includes('--sync')

async function runL2() {
  const report = runCodegraphHealthCheck()
  console.log(JSON.stringify(report, null, 2))

  const reportPush = await pushL2ReportToWorkbench(report, { operator: 'kb-sync:run' })
  if (reportPush.skipped) {
    console.warn(`kb-sync l2 report skipped: ${reportPush.reason}`)
  }

  if (checkOnly) {
    if (!report.healthy) process.exit(2)
    return
  }

  if (sync) {
    const { runCodegraphSync } = await import('../cli/codegraph-sync.mjs')
    const kbRoot = process.cwd()
    const staleCount = report.summary?.stale || 0
    if (staleCount === 0) {
      console.warn('kb-sync l2: 无 stale module，跳过 sync（全量 init 请用 npm run kb:codegraph-init）')
      return
    }
    await runCodegraphSync(kbRoot, {
      onlyStale: true,
    })
  }
}

try {
  if (domain === 'l2') await runL2()
  else {
    console.error(`unknown domain: ${domain}`)
    process.exit(1)
  }
} catch (err) {
  console.error(err.message || err)
  process.exit(1)
}
