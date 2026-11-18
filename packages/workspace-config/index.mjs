import fs from 'node:fs'
import path from 'node:path'

let cache = null

function normalizeRel(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function resolveConfigPath(repoRoot, env) {
  const explicit = String(env.WORKSPACE_APPS_CONFIG || '').trim()
  return explicit
    ? path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit)
    : path.join(repoRoot, 'config', 'workspace-apps.json')
}

export function findWorkspaceRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir)
  while (true) {
    if (fs.existsSync(path.join(current, 'config', 'workspace-apps.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(startDir)
}

export function resolveWorkspaceProfile(config, env = process.env, explicit) {
  const envName = String(config.runtime?.profile_env || 'WORKSPACE_PROFILE').trim()
  return String(explicit || env[envName] || config.runtime?.default_profile || 'default').trim()
}

export function resolveLocation(binding, options = {}) {
  if (!binding) return ''
  const repoRoot = options.repoRoot || findWorkspaceRoot()
  const profile = options.profile || 'default'
  const locations = binding.locations || binding.connections
  const selected = locations?.[profile] || locations?.default || binding.connection || binding
  const raw = String(selected?.path || '').trim()
  if (!raw) return ''
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw)
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('workspace_apps_config_invalid')
  if (!Array.isArray(config.projects) || !config.projects.length) {
    throw new Error('workspace_projects_empty')
  }
  const projects = new Set()
  const apps = new Set()
  for (const project of config.projects) {
    const projectId = String(project.project_id || '').trim()
    if (!projectId || projects.has(projectId)) throw new Error(`workspace_project_invalid:${projectId}`)
    projects.add(projectId)
    if (!project.sources?.android && !project.sources?.harmony) {
      throw new Error(`workspace_project_sources_empty:${projectId}`)
    }
    if (!Array.isArray(project.apps) || !project.apps.length) {
      throw new Error(`workspace_project_apps_empty:${projectId}`)
    }
    for (const app of project.apps) {
      const appId = String(app.app_id || '').trim()
      if (!appId || apps.has(appId)) throw new Error(`workspace_app_invalid:${appId}`)
      apps.add(appId)
      for (const knowledge of app.knowledge_sources || []) {
        const id = String(knowledge.id || knowledge.use || '').trim()
        if (!id) throw new Error(`workspace_app_knowledge_id_missing:${appId}`)
        if (knowledge.use && !(config.shared_knowledge_bases || []).some((entry) => entry.id === knowledge.use)) {
          throw new Error(`workspace_app_knowledge_reference_missing:${appId}:${knowledge.use}`)
        }
      }
    }
  }
  return config
}

export function loadWorkspaceConfig(options = {}) {
  const env = options.env || process.env
  const repoRoot = options.repoRoot || findWorkspaceRoot(options.startDir)
  const filePath = options.path || resolveConfigPath(repoRoot, env)
  const stat = fs.statSync(filePath)
  const profileHint = options.profile || String(env.WORKSPACE_PROFILE || '')
  const key = `${filePath}:${stat.mtimeMs}:${profileHint}`
  if (!options.reload && cache?.key === key) return cache.value
  const raw = validateConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  const value = normalizeWorkspaceConfig(raw, { repoRoot, env, profile: options.profile })
  listWorkspaceLinks(value)
  for (const project of value.projects) {
    for (const knowledge of project.knowledge || []) {
      if (knowledge.use && !resolveKnowledgeBase(knowledge.use, value)) {
        throw new Error(`workspace_knowledge_reference_missing:${project.project_id}:${knowledge.use}`)
      }
      if (!knowledge.use && !knowledge.id) {
        throw new Error(`workspace_project_knowledge_id_missing:${project.project_id}`)
      }
    }
  }
  cache = { key, value }
  return value
}

export const loadWorkspaceAppsConfig = loadWorkspaceConfig

export function resetWorkspaceConfigCache() {
  cache = null
}

function mergeSource(projectSource, appSource) {
  if (!projectSource && !appSource) return null
  return { ...(projectSource || {}), ...(appSource || {}) }
}

function normalizeScope(scope, source) {
  if (!source || !scope) return null
  const mode = String(scope.mode || 'modules')
  const modules = [...new Set((scope.modules || []).map(normalizeRel).filter(Boolean))]
  return {
    source_id: source.source_id,
    path: source.resolved_path,
    workspace_alias: source.workspace_alias,
    prefixes: mode === 'whole-repository' ? [] : modules,
    index_roots: source.index_roots || (mode === 'whole-repository' ? ['.'] : undefined),
    match_all: mode === 'whole-repository',
    index_mode: source.index_mode || 'scoped',
  }
}

function normalizeSource(source, context) {
  if (!source) return null
  return {
    ...source,
    source_id: String(source.source_id || '').trim(),
    resolved_path: resolveLocation(source, context),
    workspace_alias: String(source.workspace_alias || '').trim(),
  }
}

export function normalizeWorkspaceConfig(raw, options = {}) {
  const repoRoot = options.repoRoot || findWorkspaceRoot()
  const env = options.env || process.env
  const profile = resolveWorkspaceProfile(raw, env, options.profile)
  const context = { repoRoot, profile }
  const projects = raw.projects.map((project) => {
    const sources = {
      android: normalizeSource(project.sources?.android, context),
      harmony: normalizeSource(project.sources?.harmony, context),
    }
    return { ...project, sources }
  })
  const apps = []
  for (const project of projects) {
    for (const app of project.apps) {
      if (String(app.status || project.status || 'active') !== 'active') continue
      const androidSource = normalizeSource(mergeSource(project.sources.android, app.sources?.android), context)
      const harmonySource = normalizeSource(mergeSource(project.sources.harmony, app.sources?.harmony), context)
      apps.push({
        scope_id: app.app_id,
        app_id: app.app_id,
        project_id: project.project_id,
        kb_project_id: app.kb_project_id || project.kb_project_id || project.project_id,
        label: app.label || app.app_id,
        status: app.status || project.status || 'active',
        knowledge_sources: app.knowledge_sources || [],
        android: normalizeScope(app.scope?.android, androidSource),
        harmony: normalizeScope(app.scope?.harmony, harmonySource),
      })
    }
  }
  return {
    ...raw,
    repo_root: repoRoot,
    active_profile: profile,
    projects,
    apps,
  }
}

export function findWorkspaceProject(projectId, config = loadWorkspaceConfig()) {
  return config.projects.find((project) => project.project_id === projectId) || null
}

export function findWorkspaceApp(scopeId, config = loadWorkspaceConfig()) {
  return config.apps.find((app) => app.scope_id === scopeId) || null
}

export function resolveAppSource(appOrId, platform, config = loadWorkspaceConfig()) {
  const app = typeof appOrId === 'string' ? findWorkspaceApp(appOrId, config) : appOrId
  return app?.[platform] || null
}

export function resolveProjectSource(projectId, platform, config = loadWorkspaceConfig()) {
  return findWorkspaceProject(projectId, config)?.sources?.[platform] || null
}

export function listWorkspaceApps(config = loadWorkspaceConfig()) {
  return config.apps
}

export function toLegacyScopeRows(config = loadWorkspaceConfig()) {
  return config.apps.map((app) => ({
    id: app.scope_id,
    label: app.label,
    projectId: app.project_id,
    kbProjectId: app.kb_project_id,
    prefixes: app.android?.prefixes || [],
    repoRoot: app.android?.path || '',
    repositoryId: app.android?.source_id || '',
    externalRepo: app.android?.index_mode !== 'main',
    workspaceAlias: app.android?.workspace_alias || 'android-src',
    indexRoots: app.android?.index_roots,
    matchAll: app.android?.match_all,
    harmonyRepoRoot: app.harmony?.path || '',
    harmonyRepositoryId: app.harmony?.source_id || '',
    harmonyWorkspaceAlias: app.harmony?.workspace_alias || 'harmony-src',
    harmonyPrefixes: app.harmony?.prefixes || [],
    harmonyMatchAll: app.harmony?.match_all,
  }))
}

export function resolveKnowledgeBase(id, config = loadWorkspaceConfig()) {
  const item = (config.shared_knowledge_bases || []).find((entry) => entry.id === id)
  if (!item) return null
  return {
    ...item,
    root: resolveLocation(item.connection || item, {
      repoRoot: config.repo_root,
      profile: config.active_profile,
    }),
  }
}

export function listPortalKnowledgeBases(group, config = loadWorkspaceConfig()) {
  return (config.shared_knowledge_bases || [])
    .filter((entry) => entry.enabled !== false && entry.portal?.enabled === true)
    .filter((entry) => !group || entry.portal?.group === group)
    .map((entry) => resolveKnowledgeBase(entry.id, config))
    .filter((entry) => entry?.root)
}

export function resolveProjectKnowledge(projectId, knowledgeId, config = loadWorkspaceConfig()) {
  const project = findWorkspaceProject(projectId, config)
  const entry = project?.knowledge?.find((item) => item.id === knowledgeId || item.use === knowledgeId)
  if (!entry) return null
  if (entry.use) {
    const shared = resolveKnowledgeBase(entry.use, config)
    return shared ? { ...shared, ...entry, id: entry.use, root: shared.root } : null
  }
  return {
    ...entry,
    root: resolveLocation(entry.connection || entry, {
      repoRoot: config.repo_root,
      profile: config.active_profile,
    }),
  }
}

function resolveKnowledgeBinding(binding, config) {
  const shared = binding.use ? resolveKnowledgeBase(binding.use, config) : null
  const source = shared ? { ...shared, ...binding, id: binding.use, root: shared.root } : {
    ...binding,
    root: resolveLocation(binding.connection || binding, {
      repoRoot: config.repo_root,
      profile: config.active_profile,
    }),
  }
  if (!source.root) return source
  const contentSubpath = normalizeRel(binding.content_subpath || source.query?.content_root || '')
  return {
    ...source,
    content_subpath: contentSubpath,
    content_root: contentSubpath ? path.resolve(source.root, contentSubpath) : source.root,
  }
}

export function resolveAppKnowledgeSources(appId, config = loadWorkspaceConfig()) {
  const app = findWorkspaceApp(appId, config)
  const project = app ? findWorkspaceProject(app.project_id, config) : null
  if (!app || !project) return []
  const bindings = [...(project.knowledge || []), ...(app.knowledge_sources || [])]
  const byId = new Map()
  for (const binding of bindings) {
    const id = String(binding.id || binding.use || '').trim()
    if (!id) continue
    const resolved = resolveKnowledgeBinding(binding, config)
    if (!resolved || resolved.enabled === false) continue
    byId.set(id, {
      ...resolved,
      id,
      app_id: app.app_id,
      project_id: app.project_id,
      kb_project_id: binding.kb_project_id || app.kb_project_id,
      role: binding.role || resolved.role || 'reference',
    })
  }
  return [...byId.values()]
}

export function resolveAppKnowledgeSource(appId, sourceId, config = loadWorkspaceConfig()) {
  return resolveAppKnowledgeSources(appId, config).find((source) => source.id === sourceId) || null
}

export function resolveDocument(projectId, documentId, config = loadWorkspaceConfig()) {
  const project = findWorkspaceProject(projectId, config)
  const document = project?.documents?.find((entry) => entry.id === documentId)
  if (!document) return null
  const configuredRoot = resolveLocation(document, {
    repoRoot: config.repo_root,
    profile: config.active_profile,
  })
  const source = project.sources?.[document.from]
  const repositoryRoot = configuredRoot || (
    source?.resolved_path
      ? path.resolve(source.resolved_path, document.repository_subpath || '')
      : ''
  )
  const contentSubpath = document.content_subpath ?? document.subpath ?? ''
  return {
    ...document,
    repository_root: repositoryRoot,
    root: repositoryRoot ? path.resolve(repositoryRoot, contentSubpath) : '',
  }
}

export function listWorkspaceLinks(config = loadWorkspaceConfig()) {
  const links = []
  for (const project of config.projects) {
    for (const platform of ['android', 'harmony']) {
      const source = project.sources?.[platform]
      if (source?.workspace_alias && source.resolved_path) {
        links.push({
          id: source.source_id,
          kind: 'source',
          alias: source.workspace_alias,
          root: source.resolved_path,
        })
      }
    }
    for (const document of project.documents || []) {
      if (!document.workspace_alias) continue
      const resolved = resolveDocument(project.project_id, document.id, config)
      if (resolved?.root) {
        links.push({ id: document.id, kind: 'document', alias: document.workspace_alias, root: resolved.root })
      }
    }
    for (const knowledge of project.knowledge || []) {
      if (!knowledge.workspace_alias) continue
      const resolved = resolveProjectKnowledge(project.project_id, knowledge.id || knowledge.use, config)
      if (resolved?.root) {
        links.push({
          id: knowledge.id || knowledge.use,
          kind: 'knowledge',
          alias: knowledge.workspace_alias,
          root: resolved.root,
        })
      }
    }
  }
  for (const kb of config.shared_knowledge_bases || []) {
    if (!kb.enabled || !kb.workspace_alias) continue
    const resolved = resolveKnowledgeBase(kb.id, config)
    if (resolved?.root) {
      links.push({ id: kb.id, kind: 'knowledge', alias: kb.workspace_alias, root: resolved.root })
    }
  }

  const byAlias = new Map()
  for (const link of links) {
    const existing = byAlias.get(link.alias)
    if (existing && path.resolve(existing.root) !== path.resolve(link.root)) {
      throw new Error(`workspace_alias_conflict:${link.alias}:${existing.id}:${link.id}`)
    }
    if (!existing) byAlias.set(link.alias, link)
  }
  return [...byAlias.values()]
}

function toSyncRepo(base, source, projectId, platform) {
  if (!source?.sync || !source.resolved_path) return []
  const rows = [{
    id: source.source_id,
    label: source.label || `${base} ${platform}`,
    path: source.resolved_path,
    source_id: source.source_id,
    platform,
    remote_match: source.sync.remote_match || [],
    track_branches: source.sync.branches || [],
    codegraph_projects: source.codegraph === false ? [] : [projectId],
    deploy_on_change: source.sync.deploy_on_change,
    preserve_local_files: source.sync.preserve_local_files,
  }]
  for (const nested of source.nested_repositories || []) {
    rows.push({
      id: nested.id,
      label: nested.label || nested.id,
      path: path.resolve(source.resolved_path, nested.path_suffix || ''),
      path_suffix: nested.path_suffix,
      source_id: source.source_id,
      platform,
      remote_match: nested.sync?.remote_match || [],
      track_branches: nested.sync?.branches || [],
      codegraph_projects: nested.codegraph === false ? [] : [projectId],
      deploy_on_change: nested.sync?.deploy_on_change,
      preserve_local_files: nested.sync?.preserve_local_files,
    })
  }
  return rows
}

export function listRepoSyncRepositories(config = loadWorkspaceConfig()) {
  const rows = []
  for (const project of config.projects) {
    rows.push(...toSyncRepo(project.label || project.project_id, project.sources.android, project.project_id, 'android'))
    rows.push(...toSyncRepo(project.label || project.project_id, project.sources.harmony, project.project_id, 'harmony'))
    for (const document of project.documents || []) {
      if (!document.sync) continue
      const resolved = resolveDocument(project.project_id, document.id, config)
      if (!resolved?.root) continue
      rows.push({
        id: document.id,
        label: document.label || document.id,
        path: resolved.repository_root || resolved.root,
        source_id: document.id,
        platform: 'document',
        remote_match: document.sync.remote_match || [],
        track_branches: document.sync.branches || [],
        codegraph_projects: [],
        deploy_on_change: document.sync.deploy_on_change,
        preserve_local_files: document.sync.preserve_local_files,
      })
    }
    for (const knowledge of project.knowledge || []) {
      if (knowledge.use || !knowledge.sync) continue
      const resolved = resolveProjectKnowledge(project.project_id, knowledge.id, config)
      if (!resolved?.root) continue
      rows.push({
        id: knowledge.id,
        label: knowledge.label || knowledge.id,
        path: resolved.root,
        source_id: knowledge.id,
        platform: 'knowledge',
        remote_match: knowledge.sync.remote_match || [],
        track_branches: knowledge.sync.branches || [],
        codegraph_projects: [],
        deploy_on_change: knowledge.sync.deploy_on_change,
        preserve_local_files: knowledge.sync.preserve_local_files,
      })
    }
  }
  for (const kb of config.shared_knowledge_bases || []) {
    if (!kb.sync) continue
    const resolved = resolveKnowledgeBase(kb.id, config)
    if (!resolved?.root) continue
    rows.push({
      id: kb.id,
      label: kb.label || kb.id,
      path: resolved.root,
      source_id: kb.id,
      platform: 'knowledge',
      remote_match: kb.sync.remote_match || [],
      track_branches: kb.sync.branches || [],
      codegraph_projects: [],
      deploy_on_change: kb.sync.deploy_on_change,
      preserve_local_files: kb.sync.preserve_local_files,
    })
  }
  return rows
}
