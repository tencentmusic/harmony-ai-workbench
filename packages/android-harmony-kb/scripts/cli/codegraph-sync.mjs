import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getCodegraphAppPaths } from '../lib/codegraph-app-context.mjs'
import { loadAppCodeModules } from '../lib/app-code-modules.mjs'
import { syncAppCodegraphConfigs } from '../lib/codegraph-config.mjs'
import { runCmd } from '../lib/paths.mjs'

function log(msg) {
  console.log(msg)
}

function npmGlobalBin() {
  try {
    return execSync('npm bin -g', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function envWithGlobalBin() {
  const bin = npmGlobalBin()
  if (!bin) return process.env
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }
}

function ensureCodegraphCli(env) {
  try {
    return execSync('codegraph --version', { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    throw new Error('codegraph CLI 不可用，请先 npm run kb:codegraph-init 或 npm i -g @colbymchenry/codegraph')
  }
}

function checkSourceRepos(projects) {
  const missing = []
  for (const projectId of projects) {
    const ctx = getCodegraphAppPaths(projectId)
    if (!fs.existsSync(ctx.androidRepo)) {
      missing.push({ project_id: projectId, name: 'Android', path: ctx.androidRepo })
    }
    if (!fs.existsSync(ctx.harmonyRepo)) {
      missing.push({ project_id: projectId, name: 'Harmony', path: ctx.harmonyRepo })
    }
  }
  return missing
}

function isModuleStale(modulePath) {
  const indexDir = path.join(modulePath, '.codegraph')
  if (!fs.existsSync(indexDir)) return false
  try {
    const indexMtime = fs.statSync(indexDir).mtimeMs
    const sourceMtime = fs.statSync(modulePath).mtimeMs
    return sourceMtime > indexMtime + 60_000
  } catch {
    return false
  }
}

function syncModules(ctx, modules, platform, options = {}) {
  let synced = 0
  let skipped = 0
  const details = []

  for (const modRel of modules) {
    const modulePath =
      platform === 'android' ? ctx.resolveAndroidModulePath(modRel) : path.join(ctx.harmonyRepo, modRel)
    const indexDir = path.join(modulePath, '.codegraph')
    if (!fs.existsSync(modulePath)) {
      skipped++
      details.push({ module: modRel, status: 'missing_module' })
      continue
    }
    if (!fs.existsSync(indexDir)) {
      skipped++
      details.push({ module: modRel, status: 'no_index_run_kb_codegraph_init' })
      log(`  ⚠ skip ${modRel}（无 .codegraph/，请 kb:codegraph-init）`)
      continue
    }
    if (options.onlyStale && !isModuleStale(modulePath)) {
      skipped++
      details.push({ module: modRel, status: 'fresh_skip' })
      continue
    }
    log(`  sync ${modRel} …`)
    try {
      runCmd('codegraph sync', { cwd: modulePath, stdio: 'pipe' })
      synced++
      details.push({ module: modRel, status: 'synced' })
    } catch (e) {
      details.push({ module: modRel, status: 'sync_failed', error: e.message?.slice(0, 120) })
      log(`  ✗ ${modRel}: ${e.message?.split('\n')[0] || 'sync failed'}`)
    }
  }

  return { platform, synced, skipped, total: modules.length, details }
}

/** 增量更新各源码模块的 `.codegraph` 索引，不生产或回写 L1 知识。 */
export function runCodegraphSync(kbRoot, options = {}) {
  const projects = options.projects || loadAppCodeModules().apps
    .filter((app) => app.status === 'active')
    .map((app) => app.project_id || app.app_id)
  log('=== harmony-kb codegraph-sync（增量 · 多 App）===')
  log(`  projects: ${projects.join(', ')}`)
  log('  · codegraph sync — 自上次索引以来变更的文件（官方 incremental）')
  log('  · L1 知识由外部知识生产工程独立维护，本命令不会写入知识文件\n')

  const missing = checkSourceRepos(projects)
  if (missing.length) {
    for (const m of missing) {
      log(`✗ [${m.project_id}] ${m.name} 源码仓不存在: ${m.path}`)
    }
    if (!options.force) throw new Error('source_repo_missing')
  }

  const env = envWithGlobalBin()
  const ver = ensureCodegraphCli(env)
  log(`codegraph ${ver}\n`)

  const projectResults = []
  let totalSynced = 0
  let totalModules = 0

  for (const projectId of projects) {
    const ctx = getCodegraphAppPaths(projectId)
    log(`→ [${projectId}] Android modules (codegraph sync) …`)
    syncAppCodegraphConfigs({ appId: ctx.appId, platform: 'android', appPaths: ctx })
    const android = syncModules(ctx, ctx.androidModules, 'android', options)
    log(`\n→ [${projectId}] Harmony modules (codegraph sync) …`)
    syncAppCodegraphConfigs({ appId: ctx.appId, platform: 'harmonyos', appPaths: ctx })
    const harmony = syncModules(ctx, ctx.harmonyModules, 'harmonyos', options)
    projectResults.push({ project_id: projectId, android, harmony })
    totalSynced += android.synced + harmony.synced
    totalModules += android.total + harmony.total
  }

  if (options.onlyStale && totalSynced === 0) {
    log('\n✓ 无 stale module，跳过 sync')
    return { version: ver, projects: projectResults, onlyStale: true }
  }

  if (totalSynced === 0 && !options.force) {
    log('\n⚠ 无任何 module 完成 sync；请先 npm run kb:codegraph-init')
    throw new Error('no_index_to_sync')
  }

  log(`\ncodegraph-sync ok: ${totalSynced}/${totalModules} modules synced across ${projects.length} project(s)`)
  return { version: ver, projects: projectResults }
}
