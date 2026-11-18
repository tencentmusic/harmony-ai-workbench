import { loadWorkspaceAppsConfig, listRepoSyncRepositories } from '@/lib/workspace-apps-config'
import { CloudError, record, validBranch } from './domain'
import type { CloudApp } from '@/contracts/cloud-agent'
import { documentPrefix } from './branch-documents'

export interface CloudProject extends CloudApp {
  projectId: string; kbProjectId: string; harmonyRoot: string; androidRoot: string; androidPrefixes: string[]; harmonyPrefixes: string[]
  branchPatterns: string[]; mrTrigger: boolean; documentsPath: string
}
export function cloudProjects(): CloudProject[] {
  const config = loadWorkspaceAppsConfig()
  return config.apps.flatMap(app => {
    const owner = config.projects.find(project => project.project_id === app.project_id)
    const raw = owner?.apps.find(candidate => candidate.app_id === app.app_id)
    if (!raw?.cloud_agent) return []
    const setting = record(raw.cloud_agent)
    if (setting.enabled !== true || !app.harmony || !app.android) return []
    const branch = String(setting.release_branch || '')
    const patterns = setting.allowed_branches
    if (!validBranch(branch) || !Array.isArray(patterns) || !patterns.length || !patterns.every(item => typeof item === 'string' && item.length <= 180)) throw new CloudError('云Agent 分支配置错误', 503)
    const model = typeof setting.model === 'string' ? setting.model : 'gpt-6-astra'
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new CloudError('云Agent 模型配置错误', 503)
    if (setting.documents_path !== undefined && typeof setting.documents_path !== 'string') throw new CloudError('文档归档目录配置必须是字符串', 503)
    const documentsPath = typeof setting.documents_path === 'string' ? setting.documents_path : 'docs/migrations'
    documentPrefix(documentsPath, app.app_id, 'validation')
    const project: CloudProject = { id: app.app_id, label: app.label, projectId: app.project_id, kbProjectId: app.kb_project_id, defaultBranch: branch, model,
      harmonyRoot: app.harmony.path, androidRoot: app.android.path, androidPrefixes: app.android.match_all ? [''] : app.android.prefixes,
      harmonyPrefixes: app.harmony.match_all ? [''] : app.harmony.prefixes, branchPatterns: patterns as string[], mrTrigger: setting.mr_trigger === true, documentsPath }
    if (!branchAllowed(project, branch)) throw new CloudError('默认鸿蒙分支不在允许列表', 503)
    return [project]
  })
}
export function branchAllowed(project: CloudProject, branch: string) {
  return validBranch(branch) && project.branchPatterns.some(pattern => {
    const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${escaped}$`).test(branch)
  })
}
export function cloudProject(id: string) {
  const project = cloudProjects().find(item => item.id === id)
  if (!project) throw new CloudError('App 未启用云Agent', 403)
  return project
}
export function androidSyncSources() {
  const config = loadWorkspaceAppsConfig()
  const rows = listRepoSyncRepositories(config) as unknown[]
  return rows.map(record).filter(row => row.platform === 'android').map(row => ({
    id: String(row.id), root: String(row.path), suffix: String(row.path_suffix || ''),
    branches: Array.isArray(row.track_branches) ? row.track_branches.filter((v): v is string => typeof v === 'string') : [],
    projectIds: config.projects.filter(project => project.sources.android?.source_id === row.source_id).map(project => project.project_id),
  }))
}
