export function buildSession(introspect) {
  const scopes = Array.isArray(introspect.scopes) ? introspect.scopes : []
  const allowedKbProjectIds = Array.isArray(introspect.allowedKbProjectIds)
    ? introspect.allowedKbProjectIds
    : []
  const prefixEntries = []
  for (const scope of scopes) {
    const prefixes = Array.isArray(scope.prefixes) ? scope.prefixes : []
    for (const prefix of prefixes) {
      prefixEntries.push({
        scopeId: scope.id,
        kbProjectId: scope.kbProjectId || 'demo-project',
        workspaceAlias: scope.workspaceAlias || 'android-src',
        repositoryId: scope.repositoryId || '',
        repoRoot: scope.repoRoot || '',
        prefix: prefix === '.' ? '' : String(prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      })
    }
    if (!prefixes.length && scope.matchAll) {
      prefixEntries.push({
        scopeId: scope.id,
        kbProjectId: scope.kbProjectId || 'demo-project',
        workspaceAlias: scope.workspaceAlias || 'android-src',
        repositoryId: scope.repositoryId || '',
        repoRoot: scope.repoRoot || '',
        prefix: '',
      })
    }
  }
  return {
    tokenId: introspect.tokenId,
    personCode: introspect.personCode,
    personName: introspect.personName,
    appScopeIds: introspect.appScopeIds || [],
    allowedKbProjectIds: allowedKbProjectIds.length ? allowedKbProjectIds : ['demo-project'],
    prefixEntries,
  }
}

export function assertKbProject(session, projectId) {
  const pid = String(projectId || 'demo-project').trim()
  if (!session.allowedKbProjectIds.includes(pid)) {
    throw new Error(`project_id_not_allowed:${pid}`)
  }
  return pid
}

export function assertAndroidPlatform(platform) {
  const p = String(platform || 'android').trim().toLowerCase()
  if (p !== 'android') throw new Error('harmony_platform_not_allowed')
  return p
}

export function entriesForProject(session, projectId) {
  return session.prefixEntries.filter((e) => e.kbProjectId === projectId)
}

export function normalizeModuleRel(moduleRel) {
  let rel = String(moduleRel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  for (const prefix of ['harmony-live-src/', 'harmony-src/', 'live-src/', 'android-src/']) {
    if (rel.startsWith(prefix)) rel = rel.slice(prefix.length)
  }
  const hash = rel.indexOf('#')
  if (hash >= 0) rel = rel.slice(0, hash)
  return rel.replace(/^\/+/, '')
}

export function moduleInScope(session, projectId, moduleRel) {
  const rel = normalizeModuleRel(moduleRel)
  if (!rel) return true
  const entries = entriesForProject(session, projectId)
  if (!entries.length) return false
  return entries.some((e) => {
    if (!e.prefix) return true
    return rel === e.prefix || rel.startsWith(`${e.prefix}/`)
  })
}

export function assertModuleInScope(session, projectId, moduleRel) {
  if (!moduleRel) return
  if (!moduleInScope(session, projectId, moduleRel)) {
    throw new Error(`module_out_of_scope:${normalizeModuleRel(moduleRel)}`)
  }
}

export function resolveRepoRoot(entry) {
  const root = String(entry.repoRoot || '').trim()
  if (!root) throw new Error(`repo_root_missing:${entry.repositoryId || entry.scopeId || 'unknown'}`)
  return root.replace(/\\/g, '/').replace(/\/+$/, '')
}

function repoRelativeMatchesPrefix(repoRelative, prefix) {
  if (!prefix) return true
  return repoRelative === prefix || repoRelative.startsWith(`${prefix}/`)
}

/** 在 token 多 App scope 下，按路径匹配正确的 prefix entry（不能只用 find 第一个 android-src） */
export function findPrefixEntryForWorkspacePath(session, workspacePath) {
  const normalized = String(workspacePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) throw new Error('invalid_path')

  const alias = normalized.split('/')[0]
  const repoRelative = normalized.slice(alias.length + 1)
  if (!repoRelative) throw new Error('path_must_include_file')

  const candidates = session.prefixEntries.filter((e) => e.workspaceAlias === alias)
  if (!candidates.length) throw new Error(`workspace_alias_not_allowed:${alias}`)

  const entry = candidates.find((e) => repoRelativeMatchesPrefix(repoRelative, e.prefix))
  if (!entry) throw new Error(`path_out_of_scope:${normalized}`)
  return { normalized, alias, repoRelative, entry }
}

export function parseWorkspacePath(workspacePath, session) {
  const { normalized, repoRelative, entry } = findPrefixEntryForWorkspacePath(session, workspacePath)
  const repoRoot = resolveRepoRoot(entry)
  return {
    entry,
    workspacePath: normalized,
    repoRoot,
    repoRelative,
    absolutePath: `${repoRoot}/${repoRelative}`.replace(/\/+/g, '/'),
  }
}
