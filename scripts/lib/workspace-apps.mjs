import path from 'node:path'
import {
  findWorkspaceApp,
  findWorkspaceProject,
  listRepoSyncRepositories,
  listPortalKnowledgeBases,
  listWorkspaceLinks,
  listWorkspaceApps,
  loadWorkspaceConfig,
  resetWorkspaceConfigCache,
  resolveAppSource,
  resolveAppKnowledgeSource,
  resolveDocument,
  resolveKnowledgeBase,
  resolveProjectKnowledge,
  resolveLocation,
  resolveProjectSource,
  toLegacyScopeRows,
} from '@kugou/workspace-config'

export const loadWorkspaceAppsConfig = loadWorkspaceConfig
export {
  findWorkspaceApp,
  findWorkspaceProject,
  listRepoSyncRepositories,
  listWorkspaceLinks,
  listWorkspaceApps,
  resetWorkspaceConfigCache,
  resolveAppSource,
  resolveAppKnowledgeSource,
  resolveDocument,
  resolveKnowledgeBase,
  resolveProjectKnowledge,
  resolveProjectSource,
  toLegacyScopeRows,
}

export function getWorkbenchRepoRoot() {
  return loadWorkspaceConfig().repo_root
}

export function resolveRepoPath(binding, _env = process.env, repoRoot) {
  if (binding?.resolved_path) return binding.resolved_path
  return resolveLocation(binding, {
    repoRoot: repoRoot || loadWorkspaceConfig().repo_root,
    profile: loadWorkspaceConfig().active_profile,
  })
}

export function resolveSharedAndroidMonorepoPath(config = loadWorkspaceConfig()) {
  return config.projects.find((project) => project.sources?.android?.index_mode === 'main')
    ?.sources?.android?.resolved_path || ''
}

export function resolveAppAndroidRepoPath(app, config = loadWorkspaceConfig()) {
  return findWorkspaceApp(app?.scope_id || app?.app_id, config)?.android?.path || ''
}

export function resolveAppHarmonyRepoPath(app, config = loadWorkspaceConfig()) {
  return findWorkspaceApp(app?.scope_id || app?.app_id, config)?.harmony?.path || ''
}

export function getSharedPathBinding(key, config = loadWorkspaceConfig()) {
  if (key === 'android_monorepo') {
    const source = config.projects.find((project) => project.sources?.android?.index_mode === 'main')?.sources?.android
    return source ? { path: source.resolved_path } : undefined
  }
  if (key === 'harmony') {
    const source = config.projects.find((project) => project.sources?.harmony)?.sources?.harmony
    return source ? { path: source.resolved_path } : undefined
  }
  if (key === 'harmony_docs') {
    const source = listPortalKnowledgeBases('migration', config)[0]
    if (!source?.root) return undefined
    const contentRoot = String(source.query?.content_root || '').trim()
    return { path: contentRoot ? path.resolve(source.root, contentRoot) : source.root }
  }
  if (key === 'knowledge_base') {
    const kb = resolveKnowledgeBase('android-harmony-kb', config)
    return kb?.root ? { path: kb.root } : undefined
  }
  return undefined
}
