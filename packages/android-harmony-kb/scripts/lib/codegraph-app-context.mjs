import { getAppPaths } from './paths.mjs'
import { getApp, loadAppCodeModules } from './app-code-modules.mjs'

export function resolveKbProjectId(projectId) {
  const config = loadAppCodeModules()
  const id = String(projectId || config.apps?.[0]?.project_id || '').trim()
  const app = (config.apps || []).find((item) => item.project_id === id || item.app_id === id)
  return app?.project_id || config.apps?.[0]?.project_id || ''
}

/** CodeGraph L2 运行时按 project_id 解析 Android/Harmony 仓与 module 清单 */
export function getCodegraphAppPaths(projectId = 'demo-project') {
  const id = resolveKbProjectId(projectId)
  const config = loadAppCodeModules()
  const app = getApp(config, id)
  const domainId = app.platforms?.android?.domains?.[0]?.domain_id
  return getAppPaths(app.app_id, domainId)
}

export function pickCodegraphContext(args = {}) {
  return getCodegraphAppPaths(args.project_id)
}
