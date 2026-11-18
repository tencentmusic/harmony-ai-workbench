import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getAppPaths } from '../lib/paths.mjs'
import { loadAppCodeModules } from '../lib/app-code-modules.mjs'
import { syncAppCodegraphConfigs } from '../lib/codegraph-config.mjs'

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

function codegraphVersion(env) {
  try {
    return execSync('codegraph --version', { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function checkAppRepos(appId) {
  const app = loadAppCodeModules().apps.find((item) => item.app_id === appId)
  const domainId = app?.platforms?.android?.domains?.[0]?.domain_id
  const appPaths = getAppPaths(appId, domainId)
  const missing = []
  if (!fs.existsSync(appPaths.androidRepo)) {
    missing.push({
      name: `${appId} Android`,
      path: appPaths.androidRepo,
      source: app?.platforms?.android?.source_id || 'android',
    })
  }
  if (!fs.existsSync(appPaths.harmonyRepo)) {
    missing.push({
      name: `${appId} Harmony`,
      path: appPaths.harmonyRepo,
      source: app?.platforms?.harmonyos?.source_id || 'harmony',
    })
  }
  return { appPaths, missing, domainId }
}

function resolveApps(options = {}) {
  const config = loadAppCodeModules()
  if (options.app && options.app !== 'all') {
    const app = config.apps.find((a) => a.app_id === options.app)
    if (!app) throw new Error(`app_not_found:${options.app}`)
    return [app.app_id]
  }
  return (config.apps || []).filter((a) => a.status === 'active').map((a) => a.app_id)
}

function countIndexedModules(appPaths) {
  let androidIndexed = 0
  for (const mod of appPaths.androidModules) {
    if (fs.existsSync(path.join(appPaths.resolveAndroidModulePath(mod), '.codegraph'))) androidIndexed++
  }
  let harmonyIndexed = 0
  for (const mod of appPaths.harmonyModules) {
    if (fs.existsSync(path.join(appPaths.harmonyRepo, mod, '.codegraph'))) harmonyIndexed++
  }
  return { androidIndexed, harmonyIndexed }
}

function initModules(appId, appPaths, platform, env, kbRoot) {
  syncAppCodegraphConfigs({ appId, platform, appPaths, kbRoot, force: true })
  const modules = platform === 'android' ? appPaths.androidModules : appPaths.harmonyModules
  for (const modRel of modules) {
    const modulePath = platform === 'android'
      ? appPaths.resolveAndroidModulePath(modRel)
      : path.join(appPaths.harmonyRepo, modRel)
    if (!fs.existsSync(modulePath)) {
      log(`  ⚠ skip ${modRel}（module 不存在）`)
      continue
    }
    log(`  init ${modRel} …`)
    execSync('codegraph init', { cwd: modulePath, stdio: 'inherit', env })
  }
}

/** 安装全局 CodeGraph CLI + 各 App Android/Harmony module 索引 */
export function runCodegraphInit(kbRoot, options = {}) {
  log('=== harmony-kb codegraph-init ===')
  log('（全局 CodeGraph CLI + 各 App module `.codegraph/` 索引）\n')

  const appIds = resolveApps(options)
  const repoChecks = appIds.map((appId) => ({ appId, ...checkAppRepos(appId) }))
  const allMissing = repoChecks.flatMap((r) => r.missing)

  for (const { appId, appPaths, missing } of repoChecks) {
    if (missing.length) continue
    log(`${appId}:`)
    log(`  Android: ${appPaths.androidRepo.replace(/\\/g, '/')}`)
    log(`  Harmony: ${appPaths.harmonyRepo.replace(/\\/g, '/')}`)
  }
  log('')

  if (allMissing.length && !options.force) {
    for (const m of allMissing) {
      log(`✗ ${m.name} 源码仓不存在: ${m.path}`)
      log(`  请检查 workspace-apps.json: ${m.source}`)
    }
    throw new Error('source_repo_missing')
  }

  log('→ npm i -g @colbymchenry/codegraph …')
  execSync('npm i -g @colbymchenry/codegraph', { stdio: 'inherit' })

  const env = envWithGlobalBin()
  const ver = codegraphVersion(env)
  if (!ver) {
    throw new Error('codegraph CLI 安装后仍不可用，请新开终端或将 npm 全局 bin 加入 PATH 后重试')
  }
  log(`✓ codegraph ${ver}\n`)

  const summary = []
  for (const { appId, appPaths, missing, domainId } of repoChecks) {
    if (missing.length) {
      log(`⚠ skip ${appId}（源码仓缺失）`)
      continue
    }
    log(`→ ${appId} Android CodeGraph …`)
    initModules(appId, appPaths, 'android', env, kbRoot)
    log(`→ ${appId} Harmony CodeGraph …`)
    initModules(appId, appPaths, 'harmonyos', env, kbRoot)

    const counts = countIndexedModules(appPaths)
    summary.push({
      appId,
      domainId,
      ...counts,
      androidTotal: appPaths.androidModules.length,
      harmonyTotal: appPaths.harmonyModules.length,
    })
  }

  for (const s of summary) {
    log(`\ncodegraph-init ${s.appId}: Android ${s.androidIndexed}/${s.androidTotal}, Harmony ${s.harmonyIndexed}/${s.harmonyTotal}`)
  }

  return { version: ver, summary }
}
