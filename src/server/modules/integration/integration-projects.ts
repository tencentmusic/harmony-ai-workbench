import path from 'node:path'

import { isValidGitBranchName } from './integration-domain'
import { loadWorkspaceAppsConfig, resolveProjectSource } from '@/lib/workspace-apps-config'

export interface IntegrationProjectConfig {
  id: string
  label: string
  repoRoot: string
  defaultTargetBranch: string
  scopePath?: string
  appScopeId?: string
  selectable?: boolean
}

export type PublicIntegrationProject = Omit<IntegrationProjectConfig, 'repoRoot'>

const PROJECT_ID_MAX_LENGTH = 64
const REPO_ROOT_MAX_LENGTH = 1024
const SCOPE_PATH_MAX_LENGTH = 512
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function requireNonEmptyString(
  value: unknown,
  field: keyof IntegrationProjectConfig,
  index: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`HARMONY_INTEGRATION_PROJECTS[${index}].${field} 必须为非空字符串`)
  }

  return value
}

function normalizeRepoRoot(repoRoot: string, index: number): string {
  if (CONTROL_CHARACTER_PATTERN.test(repoRoot)) {
    throw new Error(`HARMONY_INTEGRATION_PROJECTS[${index}].repoRoot 不能包含控制字符`)
  }
  if (repoRoot.length > REPO_ROOT_MAX_LENGTH) {
    throw new Error(
      `HARMONY_INTEGRATION_PROJECTS[${index}].repoRoot 不能超过 ${REPO_ROOT_MAX_LENGTH} 个字符`,
    )
  }

  if (!path.isAbsolute(repoRoot)) {
    throw new Error(`HARMONY_INTEGRATION_PROJECTS[${index}].repoRoot 必须是绝对路径`)
  }
  const normalized = path.resolve(repoRoot)
  if (normalized === path.parse(normalized).root) {
    throw new Error(`HARMONY_INTEGRATION_PROJECTS[${index}].repoRoot 不能是文件系统仓库根目录`)
  }

  return normalized
}

export function normalizeIntegrationScopePath(
  scopePath: string,
  fieldName = 'scopePath',
): string {
  if (CONTROL_CHARACTER_PATTERN.test(scopePath)) {
    throw new Error(`${fieldName} 不能包含控制字符`)
  }
  if (scopePath.length > SCOPE_PATH_MAX_LENGTH) {
    throw new Error(`${fieldName} 不能超过 ${SCOPE_PATH_MAX_LENGTH} 个字符`)
  }
  if (
    path.posix.isAbsolute(scopePath) ||
    path.win32.isAbsolute(scopePath) ||
    scopePath.includes('\\')
  ) {
    throw new Error(`${fieldName} 必须是规范化的相对路径`)
  }

  const segments = scopePath.split('/')
  if (segments.includes('..')) {
    throw new Error(`${fieldName} 不能包含上级目录 ..`)
  }

  const normalized = path.posix.normalize(scopePath).replace(/\/$/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`${fieldName} 必须是规范化的相对路径`)
  }

  return normalized
}

export function parseIntegrationProjects(raw: string | undefined): IntegrationProjectConfig[] {
  if (!raw?.trim()) {
    throw new Error('环境变量 HARMONY_INTEGRATION_PROJECTS 不能为空')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('环境变量 HARMONY_INTEGRATION_PROJECTS 不是合法的 JSON')
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('HARMONY_INTEGRATION_PROJECTS 必须是数组，且至少配置一个项目')
  }

  const seenIds = new Set<string>()

  return parsed.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`HARMONY_INTEGRATION_PROJECTS[${index}] 必须是项目对象`)
    }

    const candidate = item as Record<string, unknown>
    const id = requireNonEmptyString(candidate.id, 'id', index)
    const label = requireNonEmptyString(candidate.label, 'label', index).trim()
    const rawRepoRoot = requireNonEmptyString(candidate.repoRoot, 'repoRoot', index)
    const defaultTargetBranch = requireNonEmptyString(
      candidate.defaultTargetBranch,
      'defaultTargetBranch',
      index,
    )

    if (
      id.length > PROJECT_ID_MAX_LENGTH ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)
    ) {
      throw new Error(
        `HARMONY_INTEGRATION_PROJECTS[${index}].id 必须是 1-${PROJECT_ID_MAX_LENGTH} 位安全 slug`,
      )
    }

    if (seenIds.has(id)) {
      throw new Error(`HARMONY_INTEGRATION_PROJECTS 项目 id 重复：${id}`)
    }
    seenIds.add(id)

    const repoRoot = normalizeRepoRoot(rawRepoRoot, index)

    if (!isValidGitBranchName(defaultTargetBranch)) {
      throw new Error(
        `HARMONY_INTEGRATION_PROJECTS[${index}].defaultTargetBranch 必须是合法的分支名`,
      )
    }

    let scopePath: string | undefined
    if (candidate.scopePath !== undefined) {
      scopePath = normalizeIntegrationScopePath(
        requireNonEmptyString(candidate.scopePath, 'scopePath', index),
      )
    }

    return {
      id,
      label,
      repoRoot,
      defaultTargetBranch,
      scopePath,
    }
  })
}

export function loadIntegrationProjectsFromEnv(
  env: Record<string, string | undefined> = process.env,
): IntegrationProjectConfig[] {
  return parseIntegrationProjects(env.HARMONY_INTEGRATION_PROJECTS)
}

export function loadIntegrationProjects(
  env: Record<string, string | undefined> = process.env,
): IntegrationProjectConfig[] {
  const config = loadWorkspaceAppsConfig()
  const legacy = env.HARMONY_INTEGRATION_PROJECTS?.trim()
    ? loadIntegrationProjectsFromEnv(env)
    : []
  const seenIds = new Set(legacy.map(project => project.id))
  const apps = config.apps
    .filter(app => (app.status || 'active') === 'active')
    .map((app, index): IntegrationProjectConfig => {
      const id = `app-${app.scope_id.toLowerCase()}`
      if (!/^[a-z0-9-]+$/.test(id) || id.length > PROJECT_ID_MAX_LENGTH || seenIds.has(id)) {
        throw new Error(`集成应用项目 id 无效或重复：${id}`)
      }
      seenIds.add(id)
      const repoRoot = resolveProjectSource(app.project_id, 'harmony', config)?.resolved_path || ''
      return {
        id,
        label: app.label,
        appScopeId: app.scope_id,
        repoRoot: normalizeRepoRoot(repoRoot, index),
        // A repository-wide legacy default cannot identify an application's integration branch.
        defaultTargetBranch: '',
      }
    })
  return [...apps, ...legacy.map(project => ({ ...project, selectable: false }))]
}

export function selectableIntegrationProjects(
  projects: readonly IntegrationProjectConfig[],
  appScopeIds: readonly string[],
): IntegrationProjectConfig[] {
  return projects.filter(project => project.selectable !== false && (
    !project.appScopeId || !appScopeIds.length || appScopeIds.includes(project.appScopeId)
  ))
}

export function toPublicIntegrationProject(
  project: IntegrationProjectConfig,
): PublicIntegrationProject {
  return {
    id: project.id,
    label: project.label,
    defaultTargetBranch: project.defaultTargetBranch,
    scopePath: project.scopePath,
    ...(project.appScopeId ? { appScopeId: project.appScopeId } : {}),
    ...(project.selectable === false ? { selectable: false } : {}),
  }
}

export function toPublicIntegrationProjects(
  projects: readonly IntegrationProjectConfig[],
): PublicIntegrationProject[] {
  return projects.map(toPublicIntegrationProject)
}
