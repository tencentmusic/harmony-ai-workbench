/**
 * L2 CodeGraph 健康检测（纯检测，Webhook/CLI 共用；sync 走 codegraph-sync）
 * 检查当前 workspace 配置中登记的所有项目
 */
import fs from 'fs'
import path from 'path'
import { getCodegraphAppPaths } from './codegraph-app-context.mjs'
import { loadAppCodeModules } from './app-code-modules.mjs'

function moduleStat(ctx, moduleRel, platform = 'harmonyos') {
  const modulePath =
    platform === 'android' ? ctx.resolveAndroidModulePath(moduleRel) : path.join(ctx.harmonyRepo, moduleRel)
  const indexDir = path.join(modulePath, '.codegraph')
  if (!fs.existsSync(modulePath)) {
    return { module_rel: moduleRel, status: 'missing_module' }
  }
  if (!fs.existsSync(indexDir)) {
    return { module_rel: moduleRel, status: 'no_index' }
  }
  let indexMtime = null
  let sourceMtime = null
  try {
    indexMtime = fs.statSync(indexDir).mtimeMs
    sourceMtime = fs.statSync(modulePath).mtimeMs
  } catch {
    /* ignore */
  }
  const stale = indexMtime != null && sourceMtime != null && sourceMtime > indexMtime + 60_000
  return {
    module_rel: moduleRel,
    status: stale ? 'stale' : 'indexed',
    index_mtime: indexMtime,
    source_mtime: sourceMtime,
  }
}

function checkProject(projectId) {
  const ctx = getCodegraphAppPaths(projectId)
  const missingRepos = []
  if (!fs.existsSync(ctx.androidRepo)) missingRepos.push('android')
  if (!fs.existsSync(ctx.harmonyRepo)) missingRepos.push('harmonyos')

  const android = ctx.androidModules.map((m) => moduleStat(ctx, m, 'android'))
  const harmony = ctx.harmonyModules.map((m) => moduleStat(ctx, m, 'harmonyos'))
  const all = [
    ...android.map((x) => ({ ...x, platform: 'android', project_id: projectId })),
    ...harmony.map((x) => ({ ...x, platform: 'harmonyos', project_id: projectId })),
  ]

  const summary = {
    indexed: all.filter((x) => x.status === 'indexed').length,
    stale: all.filter((x) => x.status === 'stale').length,
    no_index: all.filter((x) => x.status === 'no_index').length,
    missing_module: all.filter((x) => x.status === 'missing_module').length,
  }

  return { project_id: projectId, missing_repos: missingRepos, summary, modules: all }
}

export function runCodegraphHealthCheck() {
  const projects = loadAppCodeModules().apps.map((app) => app.project_id)
  const reports = projects.map(checkProject)
  const allModules = reports.flatMap((r) => r.modules)
  const missingRepos = [...new Set(reports.flatMap((r) => r.missing_repos.map((x) => `${r.project_id}:${x}`)))]

  const summary = {
    indexed: allModules.filter((x) => x.status === 'indexed').length,
    stale: allModules.filter((x) => x.status === 'stale').length,
    no_index: allModules.filter((x) => x.status === 'no_index').length,
    missing_module: allModules.filter((x) => x.status === 'missing_module').length,
  }

  const healthy =
    missingRepos.length === 0 &&
    summary.stale === 0 &&
    summary.no_index === 0 &&
    summary.missing_module === 0

  return {
    domain: 'l2_codegraph',
    mode: 'check',
    healthy,
    missing_repos: missingRepos,
    summary,
    projects: reports,
    modules: allModules,
    checked_at: new Date().toISOString(),
  }
}
