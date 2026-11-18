import {
  buildPathsFromConfig,
  getApp,
  getHarmonyModulePath,
  listAllAndroidModulePaths,
  listHarmonyModulePaths,
  loadAppCodeModules,
  resolveAndroidModuleAbsPath,
} from './app-code-modules.mjs'

export function resolveKbAppId(explicit) {
  return String(explicit || process.env.KB_APP_ID || 'demo-project').trim()
}

export function resolveKbDomainId(appId, explicit, config = loadAppCodeModules()) {
  if (explicit) return explicit
  if (process.env.KB_DOMAIN_ID?.trim()) return process.env.KB_DOMAIN_ID.trim()
  const app = getApp(config, appId)
  return app.platforms?.android?.domains?.[0]?.domain_id || 'default'
}

/** @param {{ appId?: string, domainId?: string, config?: object }} [options] */
export function createKbAppContext(options = {}) {
  const config = options.config || loadAppCodeModules()
  const appId = resolveKbAppId(options.appId)
  const domainId = resolveKbDomainId(appId, options.domainId, config)
  const app = getApp(config, appId)
  const paths = buildPathsFromConfig(config, appId)
  const androidModules = listAllAndroidModulePaths(config, appId)
  const harmonyModules = listHarmonyModulePaths(config, appId, domainId)
  const harmonyPrimaryModule = getHarmonyModulePath(config, appId, domainId)

  function resolveAndroidModulePath(modRel) {
    return resolveAndroidModuleAbsPath(config, modRel, paths.androidRepo, appId)
  }

  return {
    config,
    appId,
    domainId,
    app,
    paths,
    androidModules,
    harmonyModules,
    harmonyPrimaryModule,
    resolveAndroidModulePath,
  }
}
