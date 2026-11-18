/**
 * CodeGraph 运行时 MCP 封装（供 harmony-kb-mcp 调用）
 * 支持 workspace 配置中登记的 project_id。
 */
import fs from 'fs'
import path from 'path'
import { pickCodegraphContext } from './codegraph-app-context.mjs'
import {
  fqnToCodegraphSymbol,
  getCallees,
  getCallers,
  querySymbol,
  querySymbolAsync,
  resolveAndroidModule,
  resolveHarmonySymbol,
  runCodegraph,
  runCodegraphStatusJson,
  sdkExploreMarkdown,
  sdkImpactJson,
  sdkNodeMarkdown,
  sdkStatusJson,
  simpleName,
} from './codegraph.mjs'

const DEFAULT_SEARCH_LIMIT = 8
const DEFAULT_EXPLORE_LIMIT = 6
const configuredExploreTextChars = Number(process.env.KB_CODEGRAPH_MAX_TEXT_CHARS || 24_000)
const MAX_EXPLORE_TEXT_CHARS = Number.isFinite(configuredExploreTextChars)
  ? Math.max(4_000, Math.min(configuredExploreTextChars, 100_000))
  : 24_000

function boundedExploreText(value) {
  const text = String(value || '')
  if (text.length <= MAX_EXPLORE_TEXT_CHARS) return { text, truncated: false }
  return {
    text: `${text.slice(0, MAX_EXPLORE_TEXT_CHARS)}\n\n[CodeGraph 输出已截断，请改用精确 symbol + module_rel 查询]`,
    truncated: true,
  }
}

function moduleHasIndex(modulePath) {
  return fs.existsSync(path.join(modulePath, '.codegraph'))
}

/** 去掉 Agent 误传的 workspace alias 前缀，保留仓内 module_rel */
function normalizeModuleRel(moduleRel) {
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

function toAppPaths(ctx) {
  return {
    androidModules: ctx.androidModules,
    resolveAndroidModulePath: ctx.resolveAndroidModulePath,
    harmonyRepo: ctx.harmonyRepo,
    harmonyModules: ctx.harmonyModules,
    harmonyPrimaryModule: ctx.harmonyPrimaryModule,
  }
}

export function listCodegraphModules(platform = 'android', projectId = 'demo-project') {
  const ctx = pickCodegraphContext({ project_id: projectId })
  if (platform === 'harmonyos') {
    return ctx.harmonyModules
      .filter((rel) => moduleHasIndex(path.join(ctx.harmonyRepo, rel)))
      .map((rel) => ({
        platform: 'harmonyos',
        project_id: projectId,
        modulePath: path.join(ctx.harmonyRepo, rel),
        moduleRel: rel,
      }))
  }
  return ctx.androidModules
    .filter((rel) => moduleHasIndex(ctx.resolveAndroidModulePath(rel)))
    .map((rel) => ({
      platform: 'android',
      project_id: projectId,
      modulePath: ctx.resolveAndroidModulePath(rel),
      moduleRel: rel,
    }))
}

export function resolveProjectPath({ platform = 'android', module_rel: moduleRel, project_id: projectId = 'demo-project' } = {}) {
  const ctx = pickCodegraphContext({ project_id: projectId })
  const normalized = normalizeModuleRel(moduleRel)
  if (platform === 'harmonyos') {
    const rel = normalized || ctx.harmonyPrimaryModule
    if (!rel) return null
    return path.join(ctx.harmonyRepo, rel)
  }
  if (normalized) return ctx.resolveAndroidModulePath(normalized)
  return null
}

function scoreSearchHit(hit, sym, moduleRel) {
  const node = hit?.node || hit
  const short = simpleName(sym)
  const wantFqn = sym.includes('.') ? fqnToCodegraphSymbol(sym) : null
  const normalizedRel = normalizeModuleRel(moduleRel)
  const name = String(node?.name || '')
  const qn = String(node?.qualifiedName || '')
  const kind = String(node?.kind || '')

  let score = 0
  if (name === short) score += 100
  else if (simpleName(name) === short) score += 40
  if (wantFqn && qn === wantFqn) score += 200
  if (qn.endsWith(`::${short}`)) score += 80
  if (normalizedRel && hit.module_rel === normalizedRel) score += 150
  if (kind === 'class' || kind === 'interface') score += 30
  if (/\.(?:java|kt|ets)$/.test(name)) score -= 60
  return score
}

function pickBestSearchHit(hits, sym, moduleRel) {
  if (!Array.isArray(hits) || !hits.length) return null
  return [...hits].sort((a, b) => scoreSearchHit(b, sym, moduleRel) - scoreSearchHit(a, sym, moduleRel))[0]
}

function cgSymbolFromNode(node, sym) {
  const qn = String(node?.qualifiedName || '').trim()
  if (qn.includes('::')) return qn
  if (qn.includes('.')) return fqnToCodegraphSymbol(qn)
  const short = simpleName(sym)
  if (String(node?.name || '') === short) return sym.includes('.') ? fqnToCodegraphSymbol(sym) : short
  return sym.includes('.') ? fqnToCodegraphSymbol(sym) : simpleName(sym)
}

function searchConcurrency() {
  const n = Number(process.env.KB_CODEGRAPH_SEARCH_CONCURRENCY || 4)
  if (!Number.isFinite(n) || n < 1) return 4
  return Math.min(Math.floor(n), 16)
}

function enrichQualifiedCgSymbol(modulePath, sym, moduleRel, cgSymbol) {
  const cg = String(cgSymbol || '').trim()
  if (cg.includes('::')) return cg
  const hits = querySymbol(simpleName(sym), modulePath).map((row) => ({
    node: row.node || row,
    module_rel: moduleRel,
  }))
  const hit = pickBestSearchHit(hits, sym, moduleRel)
  const qn = String(hit?.node?.qualifiedName || '').trim()
  if (qn.includes('::')) return qn
  if (qn.includes('.')) return fqnToCodegraphSymbol(qn)
  return cg
}

/** callees CLI 需要 package::Class；与 callers（简单类名）相反 */
function calleesQuerySymbol(cgSymbol, sym) {
  const cg = String(cgSymbol || '').trim()
  if (cg.includes('::')) return cg
  const s = String(sym || '').trim()
  if (s.includes('.')) return fqnToCodegraphSymbol(s)
  return cg || simpleName(s)
}

/** callers/impact CLI 需要简单类名；与 callees（package::Class）相反 */
function callersQuerySymbol(cgSymbol, sym) {
  return simpleName(cgSymbol) || simpleName(sym)
}

/** 解析 symbol 所在 module（Android 简单类名须先 search 定位 module，否则会误报 index_missing） */
async function resolveSymbolContextAsync({ symbol, platform = 'android', module_rel: moduleRel, project_id: projectId = 'demo-project' } = {}) {
  const sym = String(symbol || '').trim()
  const ctx = pickCodegraphContext({ project_id: projectId })
  const appPaths = toAppPaths(ctx)
  let modulePath = resolveProjectPath({ platform, module_rel: moduleRel, project_id: projectId })
  let resolvedModuleRel = moduleRel
  let cgSymbol = sym.includes('.') ? fqnToCodegraphSymbol(sym) : simpleName(sym)

  if (platform === 'android' && sym.includes('.')) {
    const resolved = resolveAndroidModule(sym, appPaths)
    if (resolved) {
      modulePath = resolved.modulePath
      resolvedModuleRel = resolved.moduleRel
      cgSymbol = fqnToCodegraphSymbol(sym)
    }
  } else if (platform === 'harmonyos') {
    const resolved = resolveHarmonySymbol(sym, undefined, appPaths)
    if (resolved) {
      modulePath = resolved.modulePath
      resolvedModuleRel = resolved.moduleRel
      cgSymbol = simpleName(sym)
    }
  }

  if ((!modulePath || !moduleHasIndex(modulePath)) && sym) {
    const modules = listCodegraphModules(platform, projectId).map((m) => ({ ...m, project_id: projectId }))
    const searchQuery = normalizeSearchQuery(sym.includes('.') ? simpleName(sym) : sym)
    const search =
      modules.length <= 1
        ? searchModulesSync({ query: searchQuery, modules, limit: 12 })
        : await searchModulesParallel({
            query: searchQuery,
            modules,
            limit: 12,
            concurrency: searchConcurrency(),
          })
    const hit = pickBestSearchHit(search, sym, moduleRel)
    if (hit?.module_rel) {
      resolvedModuleRel = hit.module_rel
      modulePath = resolveProjectPath({ platform, module_rel: hit.module_rel, project_id: projectId })
      cgSymbol = cgSymbolFromNode(hit.node, sym)
    }
  }

  if (modulePath && moduleHasIndex(modulePath) && sym) {
    cgSymbol = enrichQualifiedCgSymbol(modulePath, sym, resolvedModuleRel, cgSymbol)
  }

  return { sym, modulePath, moduleRel: resolvedModuleRel, cgSymbol, projectId }
}

function normalizeSearchQuery(raw) {
  const q = String(raw || '').trim()
  if (!q) return q
  if (!q.includes(' ')) return q
  if (/^[A-Za-z_][\w.]*$/.test(q)) return q
  const classMatch = q.match(/\b[A-Z][A-Za-z0-9_]*\b/)
  if (classMatch) return classMatch[0]
  return q.split(/\s+/)[0]
}

function searchModulesSync({ query, modules, limit }) {
  const hits = []
  for (const mod of modules) {
    const results = querySymbol(query, mod.modulePath).slice(0, limit)
    for (const row of results) {
      hits.push({
        platform: mod.platform,
        project_id: mod.project_id,
        module_rel: mod.moduleRel,
        node: row.node || row,
        score: row.score ?? null,
      })
      const node = row.node || row
      if (
        node?.name === query &&
        (node.kind === 'class' || node.kind === 'interface' || node.kind === 'struct')
      ) {
        return hits
      }
    }
    if (hits.length >= limit) break
  }
  return hits
}

async function searchModulesParallel({ query, modules, limit, concurrency = 4 }) {
  const results = new Array(modules.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < modules.length) {
      const index = nextIndex++
      const mod = modules[index]
      const rows = await querySymbolAsync(query, mod.modulePath)
      results[index] = rows.slice(0, limit).map((row) => ({
        platform: mod.platform,
        project_id: mod.project_id,
        module_rel: mod.moduleRel,
        node: row.node || row,
        score: row.score ?? null,
      }))
    }
  }

  const workers = Math.min(Math.max(1, concurrency), modules.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results.flat()
}

function rankSearchHits(hits, query, moduleRel) {
  return [...hits]
    .sort((a, b) => scoreSearchHit(b, query, moduleRel) - scoreSearchHit(a, query, moduleRel))
}

export async function kbCodegraphSearch({
  query,
  platform = 'android',
  module_rel: moduleRel,
  limit = DEFAULT_SEARCH_LIMIT,
  project_id: projectId = 'demo-project',
} = {}) {
  const rawQuery = String(query || '').trim()
  const q = normalizeSearchQuery(rawQuery)
  if (!q) return { hits: [], modules: [], project_id: projectId }

  const normalizedRel = normalizeModuleRel(moduleRel)
  const modules = normalizedRel
    ? listCodegraphModules(platform, projectId).filter((m) => m.moduleRel === normalizedRel)
    : listCodegraphModules(platform, projectId)

  const stamped = modules.map((m) => ({ ...m, project_id: projectId }))
  const hits =
    stamped.length <= 1
      ? searchModulesSync({ query: q, modules: stamped, limit })
      : await searchModulesParallel({ query: q, modules: stamped, limit, concurrency: searchConcurrency() })

  const ranked = rankSearchHits(hits, q, normalizedRel).slice(0, limit)
  return {
    query: rawQuery,
    search_query: q !== rawQuery ? q : undefined,
    platform,
    project_id: projectId,
    hits: ranked,
    modules: stamped.map((m) => m.moduleRel),
  }
}

export async function kbCodegraphCallees({ symbol, platform = 'android', module_rel: moduleRel, limit = 30, project_id: projectId = 'demo-project' } = {}) {
  const { sym, modulePath, moduleRel: resolvedModuleRel, cgSymbol } = await resolveSymbolContextAsync({
    symbol,
    platform,
    module_rel: moduleRel,
    project_id: projectId,
  })
  if (!sym) return { symbol: sym, callees: [], project_id: projectId }

  if (!modulePath || !moduleHasIndex(modulePath)) {
    return { symbol: sym, callees: [], project_id: projectId, error: 'codegraph_index_missing' }
  }

  try {
    const querySym = calleesQuerySymbol(cgSymbol, sym)
    const callees = getCallees(querySym, modulePath, limit)
    return {
      symbol: sym,
      cg_symbol: cgSymbol,
      query_symbol: querySym,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel,
      callees,
    }
  } catch (err) {
    return { symbol: sym, callees: [], project_id: projectId, error: err.message || 'callees_failed' }
  }
}

export async function kbCodegraphExplore({ query, platform = 'android', module_rel: moduleRel, limit = DEFAULT_EXPLORE_LIMIT, project_id: projectId = 'demo-project' } = {}) {
  const q = String(query || '').trim()
  if (!q) return { query: q, project_id: projectId, error: 'empty_query' }

  let modulePath = resolveProjectPath({ platform, module_rel: moduleRel, project_id: projectId })
  let resolvedModuleRel = moduleRel
  if (!modulePath && !moduleRel) {
    const search = await kbCodegraphSearch({ query: q, platform, limit: 1, project_id: projectId })
    const hit = search.hits?.[0]
    if (hit?.module_rel) {
      resolvedModuleRel = hit.module_rel
      modulePath = resolveProjectPath({ platform, module_rel: hit.module_rel, project_id: projectId })
    }
  }

  if (!modulePath || !moduleHasIndex(modulePath)) {
    return { query: q, platform, project_id: projectId, error: 'codegraph_index_missing', hint: 'npm run kb:codegraph-init' }
  }

  try {
    const exploreQuery = normalizeSearchQuery(q)
    const maxFiles = Math.max(1, Math.min(Number(limit) || DEFAULT_EXPLORE_LIMIT, 12))
    const sdk = sdkExploreMarkdown(exploreQuery, modulePath, maxFiles)
    if (sdk) {
      const bounded = boundedExploreText(sdk.text)
      return {
        query: q,
        platform,
        project_id: projectId,
        module_rel: resolvedModuleRel || path.basename(modulePath),
        format: 'markdown',
        text: bounded.text,
        truncated: bounded.truncated,
        result_count: sdk.result_count,
        via: 'sdk',
      }
    }
    const safe = exploreQuery.replace(/"/g, '\\"')
    // codegraph 1.5+ explore: no -j/-l; outputs markdown (aligned with official codegraph_explore MCP)
    const out = runCodegraph(`explore "${safe}" --max-files ${maxFiles}`, modulePath)
    const foundMatch = out.match(/Found\s+(\d+)\s+symbols?/i)
    const bounded = boundedExploreText(out)
    return {
      query: q,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel || path.basename(modulePath),
      format: 'markdown',
      text: bounded.text,
      truncated: bounded.truncated,
      result_count: foundMatch ? Number(foundMatch[1]) : out.trim() ? 1 : 0,
    }
  } catch (err) {
    return { query: q, platform, project_id: projectId, error: err.message || 'explore_failed' }
  }
}

export async function kbCodegraphNode({ target, platform = 'android', module_rel: moduleRel, project_id: projectId = 'demo-project' } = {}) {
  const t = String(target || '').trim()
  if (!t) return { error: 'empty_target', project_id: projectId }

  const { modulePath, moduleRel: resolvedModuleRel } = await resolveSymbolContextAsync({
    symbol: t,
    platform,
    module_rel: moduleRel,
    project_id: projectId,
  })

  if (!modulePath || !moduleHasIndex(modulePath)) {
    return { target: t, project_id: projectId, error: 'codegraph_index_missing' }
  }

  try {
    const sdk = sdkNodeMarkdown(t, modulePath)
    if (sdk) {
      return {
        target: t,
        platform,
        project_id: projectId,
        module_rel: resolvedModuleRel,
        format: 'markdown',
        text: sdk.text,
        result_count: sdk.result_count,
        via: 'sdk',
      }
    }
    const safe = t.replace(/"/g, '\\"')
    const out = runCodegraph(`node "${safe}"`, modulePath)
    return {
      target: t,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel,
      format: 'markdown',
      text: out,
      result_count: out.trim() ? 1 : 0,
    }
  } catch (err) {
    return { target: t, project_id: projectId, error: err.message || 'node_failed' }
  }
}

export function kbCodegraphFiles({ platform = 'android', module_rel: moduleRel, pattern, max_depth: maxDepth = 4, project_id: projectId = 'demo-project' } = {}) {
  const modulePath = resolveProjectPath({ platform, module_rel: moduleRel, project_id: projectId })
  if (!modulePath || !moduleHasIndex(modulePath)) {
    return {
      error: 'codegraph_index_missing',
      project_id: projectId,
      modules: listCodegraphModules(platform, projectId).map((m) => m.moduleRel),
    }
  }
  try {
    const args = ['files', '-j']
    if (pattern) args.push(`--pattern "${String(pattern).replace(/"/g, '\\"')}"`)
    if (maxDepth) args.push(`--max-depth ${maxDepth}`)
    const out = runCodegraph(args.join(' '), modulePath)
    return { platform, project_id: projectId, module_rel: moduleRel, ...JSON.parse(out) }
  } catch (err) {
    return { error: err.message || 'files_failed', project_id: projectId }
  }
}

export function kbCodegraphStatus({ platform = 'android', module_rel: moduleRel, project_id: projectId = 'demo-project' } = {}) {
  const normalizedRel = normalizeModuleRel(moduleRel)
  if (normalizedRel) {
    const modulePath = resolveProjectPath({ platform, module_rel: normalizedRel, project_id: projectId })
    if (!modulePath || !fs.existsSync(modulePath)) {
      return { error: 'module_not_found', project_id: projectId, module_rel: normalizedRel }
    }
    try {
      const sdk = sdkStatusJson(modulePath)
      if (sdk) {
        return { platform, project_id: projectId, module_rel: normalizedRel, ...sdk, via: 'sdk' }
      }
      const out = runCodegraphStatusJson(modulePath)
      return { platform, project_id: projectId, module_rel: normalizedRel, ...JSON.parse(out) }
    } catch (err) {
      return { error: err.message || 'status_failed', project_id: projectId, module_rel: normalizedRel }
    }
  }
  return {
    platform,
    project_id: projectId,
    modules: listCodegraphModules(platform, projectId).map((m) => ({
      module_rel: m.moduleRel,
      indexed: moduleHasIndex(m.modulePath),
    })),
  }
}

export async function kbCodegraphCallers({ symbol, platform = 'android', module_rel: moduleRel, limit = 30, project_id: projectId = 'demo-project' } = {}) {
  const { sym, modulePath, moduleRel: resolvedModuleRel, cgSymbol } = await resolveSymbolContextAsync({
    symbol,
    platform,
    module_rel: moduleRel,
    project_id: projectId,
  })
  if (!sym) return { callers: [], symbol: sym, project_id: projectId }

  if (!modulePath || !moduleHasIndex(modulePath)) {
    return { symbol: sym, callers: [], project_id: projectId, error: 'codegraph_index_missing' }
  }

  try {
    const querySym = callersQuerySymbol(cgSymbol, sym)
    const callers = getCallers(querySym, modulePath, limit)
    return {
      symbol: sym,
      cg_symbol: cgSymbol,
      query_symbol: querySym,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel,
      callers,
    }
  } catch (err) {
    return { symbol: sym, callers: [], project_id: projectId, error: err.message || 'callers_failed' }
  }
}

export async function kbCodegraphImpact({ symbol, platform = 'android', module_rel: moduleRel, depth = 2, limit = 40, project_id: projectId = 'demo-project' } = {}) {
  const { sym, modulePath, moduleRel: resolvedModuleRel, cgSymbol } = await resolveSymbolContextAsync({
    symbol,
    platform,
    module_rel: moduleRel,
    project_id: projectId,
  })
  if (!sym) return { symbol: sym, impacted: [], project_id: projectId }

  if (!modulePath || !moduleHasIndex(modulePath)) {
    return { symbol: sym, impacted: [], project_id: projectId, error: 'codegraph_index_missing' }
  }

  try {
    const querySym = callersQuerySymbol(cgSymbol, sym)
    const sdk = sdkImpactJson(querySym, modulePath, depth, limit)
    if (sdk) {
      return {
        symbol: sym,
        cg_symbol: cgSymbol,
        query_symbol: querySym,
        platform,
        project_id: projectId,
        module_rel: resolvedModuleRel,
        impacted: sdk.impacted,
        edges: sdk.edges,
        via: 'sdk',
      }
    }
    const safe = querySym.replace(/"/g, '\\"')
    const out = runCodegraph(`impact "${safe}" -j -d ${depth} -l ${limit}`, modulePath)
    const parsed = JSON.parse(out)
    return {
      symbol: sym,
      cg_symbol: cgSymbol,
      query_symbol: querySym,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel,
      impacted: parsed.impacted || parsed.nodes || parsed.results || [],
      edges: parsed.edges || [],
    }
  } catch {
    const querySym = callersQuerySymbol(cgSymbol, sym)
    const callees = getCallees(calleesQuerySymbol(cgSymbol, sym), modulePath, limit)
    const callersResult = await kbCodegraphCallers({ symbol: sym, platform, module_rel: resolvedModuleRel, limit, project_id: projectId })
    const callers = callersResult.callers || []
    return {
      symbol: sym,
      cg_symbol: cgSymbol,
      query_symbol: querySym,
      platform,
      project_id: projectId,
      module_rel: resolvedModuleRel,
      impacted: [...callers, ...callees],
      fallback: 'callers_callees_compose',
    }
  }
}
