import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  findWorkspaceProject,
  loadWorkspaceConfig,
  resolveProjectSource,
} from '@kugou/workspace-config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const KB_ROOT = path.resolve(__dirname, '../..')
export const APP_CODE_MODULES_PATH = path.join(KB_ROOT, 'config/app-code-modules.json')

let _cache = null

export function loadAppCodeModules(options = {}) {
  if (_cache && !options.reload) return _cache
  const raw = fs.readFileSync(options.path || APP_CODE_MODULES_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  const workspace = options.workspaceConfig || loadWorkspaceConfig({ startDir: KB_ROOT })
  _cache = {
    ...parsed,
    workspace_profile: workspace.active_profile,
    apps: (parsed.apps || []).map((app) => {
      const projectId = String(app.project_id || app.app_id || '').trim()
      const project = findWorkspaceProject(projectId, workspace)
      if (!project) throw new Error(`workspace_project_not_found:${projectId}`)
      const platforms = { ...app.platforms }
      for (const [platform, workspacePlatform] of [['android', 'android'], ['harmonyos', 'harmony']]) {
        if (!platforms[platform]) continue
        const source = resolveProjectSource(projectId, workspacePlatform, workspace)
        if (!source?.resolved_path) throw new Error(`workspace_source_not_found:${projectId}:${workspacePlatform}`)
        platforms[platform] = {
          ...platforms[platform],
          source_id: source.source_id,
          repo: {
            path: source.resolved_path,
            branch: source.branch,
            baseline_commit: source.baseline_commit,
          },
        }
      }
      return { ...app, platforms }
    }),
  }
  return _cache
}

export function getApp(config, appId) {
  const app = (config.apps || []).find((a) => a.app_id === appId || a.project_id === appId)
  if (!app) throw new Error(`app_not_found:${appId}`)
  return app
}

export function resolveRepoPath(repoConfig) {
  return String(repoConfig?.path || '').replace(/\\/g, '/')
}

/** Android module 绝对路径；源码根统一由 workspace-apps.json 的项目包解析。 */
export function resolveAndroidModuleAbsPath(config, modRel, androidRepo, appId = 'demo-project') {
  const modRelNorm = String(modRel || '').replace(/\\/g, '/')
  const app = getApp(config, appId)
  const repo = androidRepo || resolveRepoPath(app.platforms.android.repo)
  return path.join(repo, modRelNorm).replace(/\\/g, '/')
}

export function listDomainModules(app, platform, domainId = 'default', options = {}) {
  const platformCfg = app.platforms?.[platform]
  if (!platformCfg) return []
  const domain = (platformCfg.domains || []).find((d) => d.domain_id === domainId)
  if (!domain) return []
  const primary = (domain.modules || []).filter((m) => m.codegraph?.enabled !== false)
  if (!options.includeSupplementary) return primary
  const impl = (domain.modules_impl || []).filter((m) => m.codegraph?.enabled !== false)
  const legacy = (domain.modules_supplementary || []).filter((m) => m.codegraph?.enabled !== false)
  return [...primary, ...impl, ...legacy]
}

/** Android module 相对 repo 根的路径列表；默认含 modules_impl（Hive 实现层） */
export function listAndroidModulePaths(config, appId = 'demo-project', domainId = 'default', options = {}) {
  const app = getApp(config, appId)
  const includeSupplementary = options.includeSupplementary !== false
  return listDomainModules(app, 'android', domainId, { includeSupplementary }).map((m) => m.path)
}

/** 仅 API + library 层（不含 modules_impl） */
export function listAndroidOfficialModulePaths(config, appId = 'demo-project', domainId = 'default') {
  return listAndroidModulePaths(config, appId, domainId, { includeSupplementary: false })
}

/** 仅 Hive impl 实现层 */
export function listAndroidImplModulePaths(config, appId = 'demo-project', domainId = 'default') {
  const app = getApp(config, appId)
  const platformCfg = app.platforms?.android
  if (!platformCfg) return []
  const domain = (platformCfg.domains || []).find((d) => d.domain_id === domainId)
  if (!domain) return []
  return (domain.modules_impl || [])
    .filter((m) => m.codegraph?.enabled !== false)
    .map((m) => m.path)
}

/** Harmony module 相对 repo 根的路径列表 */
export function listHarmonyModulePaths(config, appId = 'demo-project', domainId = 'default') {
  const app = getApp(config, appId)
  return listDomainModules(app, 'harmonyos', domainId).map((m) => m.path)
}

/** 汇总 App 下全部 Android domain 的 CodeGraph module（按 path 去重） */
export function listAllAndroidModulePaths(config, appId = 'demo-project', options = {}) {
  const app = getApp(config, appId)
  const seen = new Set()
  const out = []
  const domainOptions = {
    includeSupplementary: options.includeSupplementary !== false,
  }
  for (const domain of app.platforms?.android?.domains || []) {
    for (const mod of listDomainModules(app, 'android', domain.domain_id, domainOptions)) {
      const p = String(mod.path || '').trim()
      if (!p || seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/** Harmony 主 module（带 primary 标记，否则取第一个） */
export function getHarmonyModulePath(config, appId = 'demo-project', domainId = 'default') {
  const app = getApp(config, appId)
  const modules = listDomainModules(app, 'harmonyos', domainId)
  if (!modules.length) return null
  const primary = modules.find((m) => m.primary)
  return (primary || modules[0]).path
}

export function buildPathsFromConfig(config, appId = 'demo-project') {
  const app = getApp(config, appId)
  const android = app.platforms.android
  const harmony = app.platforms.harmonyos
  return {
    androidRepo: resolveRepoPath(android.repo),
    harmonyRepo: resolveRepoPath(harmony.repo),
    androidCommit: android.repo.baseline_commit,
    harmonyCommit: harmony.repo.baseline_commit,
    androidBranch: android.repo.branch,
    harmonyBranch: harmony.repo.branch,
  }
}
