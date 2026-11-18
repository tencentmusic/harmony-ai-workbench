import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findWorkspaceProject,
  findWorkspaceRoot,
  loadWorkspaceConfig,
  resolveProjectKnowledge,
} from '@kugou/workspace-config'

const SUPPORTED_ADAPTERS = new Set(['feature-manifest-v1'])
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const EXACT_SYMBOL_MATCH_SCORE = 1400
const DEFAULT_MAX_CONTENT_CHARS = 6_000
const DEFAULT_CONTEXT_CONTENT_CHARS = 4_000
const MAX_CONTEXT_DOCUMENTS = 3
const FILE_CACHE = new Map()

function loadRuntimeConfig(options = {}) {
  if (options.config) return options.config
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = options.repoRoot || findWorkspaceRoot(moduleDir)
  return loadWorkspaceConfig({ repoRoot, env: options.env || process.env })
}

function normalizeText(value) {
  return String(value || '').trim().toLocaleLowerCase()
}

function normalizeTarget(value) {
  return String(value || '').trim()
}

function intersects(left = [], right = []) {
  const wanted = new Set(right)
  return left.some((item) => wanted.has(item))
}

function clampLimit(value) {
  const parsed = Number(value || DEFAULT_LIMIT)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)))
}

function readJsonCached(filePath) {
  const stat = fs.statSync(filePath)
  const hit = FILE_CACHE.get(filePath)
  if (hit?.mtimeMs === stat.mtimeMs && hit?.size === stat.size) return hit.value
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  FILE_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

function readJsonLinesCached(filePath) {
  const stat = fs.statSync(filePath)
  const hit = FILE_CACHE.get(filePath)
  if (hit?.mtimeMs === stat.mtimeMs && hit?.size === stat.size) return hit.value
  const value = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  FILE_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

function projectKnowledgeSources(projectId, config) {
  const project = findWorkspaceProject(projectId, config)
  if (!project) throw new Error(`knowledge_project_not_found:${projectId}`)
  const seen = new Set()
  const sources = []
  for (const binding of project.knowledge || []) {
    const id = String(binding.id || binding.use || '').trim()
    if (!id || seen.has(id)) continue
    const source = resolveProjectKnowledge(projectId, id, config)
    const capabilities = Array.isArray(source?.capabilities) ? source.capabilities : []
    if (
      !source ||
      source.enabled === false ||
      !capabilities.includes('mcp-query') ||
      !SUPPORTED_ADAPTERS.has(source.query?.adapter)
    ) continue
    seen.add(id)
    sources.push({ ...source, id })
  }
  return sources
}

function resolveSource(projectId, sourceId, config) {
  const sources = projectKnowledgeSources(projectId, config)
  const requested = String(sourceId || '').trim()
  if (requested) {
    const source = sources.find((entry) => entry.id === requested)
    if (!source) throw new Error(`knowledge_source_not_allowed:${projectId}:${requested}`)
    return source
  }
  if (!sources.length) throw new Error(`knowledge_source_not_configured:${projectId}`)
  if (sources.length === 1) return sources[0]
  const preferred = sources.find((entry) => entry.default === true || entry.query?.default === true)
  if (preferred) return preferred
  throw new Error(`knowledge_source_required:${projectId}:${sources.map((entry) => entry.id).join(',')}`)
}

function sourcePaths(source) {
  const contentRoot = path.resolve(source.root, source.query?.content_root || '.')
  const manifestRoot = path.join(contentRoot, 'wiki', 'indexes', 'manifest')
  return {
    contentRoot,
    manifestRoot,
    catalog: path.join(manifestRoot, 'catalog.json'),
    symbols: path.join(manifestRoot, 'symbols.jsonl'),
    routes: path.join(manifestRoot, 'routes'),
  }
}

function sourceTargets(source, projectId, explicitTarget) {
  const configured = Array.isArray(source.query?.project_targets?.[projectId])
    ? source.query.project_targets[projectId].map(normalizeTarget).filter(Boolean)
    : []
  if (!configured.length) throw new Error(`knowledge_source_targets_missing:${source.id}:${projectId}`)
  const target = normalizeTarget(explicitTarget)
  if (target && !configured.includes(target)) {
    throw new Error(`knowledge_target_not_allowed:${projectId}:${target}`)
  }
  return target ? [target] : configured
}

function requireFxwikiManifest(source) {
  const paths = sourcePaths(source)
  if (!source.root || !fs.existsSync(source.root)) {
    throw new Error(`knowledge_source_unavailable:${source.id}`)
  }
  for (const required of [paths.catalog, paths.symbols, paths.routes]) {
    if (!fs.existsSync(required)) throw new Error(`knowledge_manifest_missing:${source.id}`)
  }
  return paths
}

function loadManifest(source) {
  const paths = requireFxwikiManifest(source)
  const catalog = readJsonCached(paths.catalog)
  const symbols = readJsonLinesCached(paths.symbols)
  return { paths, catalog, symbols }
}

function routeFiles(paths) {
  return fs.readdirSync(paths.routes, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(paths.routes, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function routeShardFile(paths, shard) {
  const name = String(shard || '').trim()
  if (!name) return null
  const absolute = path.resolve(paths.routes, `${name}.json`)
  const relative = path.relative(paths.routes, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`knowledge_route_shard_invalid:${name}`)
  }
  return absolute
}

function loadRouteShards(paths, shards = []) {
  const files = uniqueStrings(shards)
    .map((shard) => routeShardFile(paths, shard))
    .filter((file) => file && fs.existsSync(file))
  return {
    shards: files.map((file) => path.basename(file, '.json')),
    routes: files.flatMap((file) => readJsonCached(file).routes || []),
  }
}

function loadAllRouteShards(paths) {
  const files = routeFiles(paths)
  return {
    shards: files.map((file) => path.basename(file, '.json')),
    routes: files.flatMap((file) => readJsonCached(file).routes || []),
  }
}

function featureRouteShards(catalog, featureIds) {
  const wanted = new Set(featureIds)
  return uniqueStrings(
    (catalog.features || [])
      .filter((feature) => wanted.has(feature.feature_id))
      .map((feature) => feature.route_shard),
  )
}

function loadFeatureRoutes(paths, catalog, featureIds) {
  return loadRouteShards(paths, featureRouteShards(catalog, featureIds))
}

function sourceStatus(source) {
  try {
    const paths = requireFxwikiManifest(source)
    const catalog = readJsonCached(paths.catalog)
    return {
      available: true,
      schema_version: catalog.schema_version || null,
      validation: catalog.validation?.status || null,
      feature_count: Array.isArray(catalog.features) ? catalog.features.length : 0,
      content_root: source.query?.content_root || '.',
      manifest: path.relative(paths.contentRoot, paths.manifestRoot).replace(/\\/g, '/'),
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function listKnowledgeSources(args = {}, options = {}) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const config = loadRuntimeConfig(options)
  const requested = String(args.source_id || '').trim()
  const sources = projectKnowledgeSources(projectId, config)
    .filter((source) => !requested || source.id === requested)
    .map((source) => ({
      source_id: source.id,
      label: source.label || source.id,
      provider: source.provider || source.id,
      adapter: source.query.adapter,
      capabilities: source.capabilities || [],
      workspace_alias: source.workspace_alias || null,
      targets: source.query?.project_targets?.[projectId] || [],
      ...sourceStatus(source),
    }))
  return { project_id: projectId, source_count: sources.length, sources }
}

function scoreText(query, value, exact, contains) {
  const text = normalizeText(value)
  if (!text) return 0
  if (text === query) return exact
  if (text.includes(query)) return contains
  if (query.includes(text)) return contains
  return 0
}

function featureScore(feature, query) {
  let score = 0
  const reasons = []
  const checks = [
    ['feature_id', feature.feature_id, 1000, 500],
    ['title', feature.title, 950, 520],
    ['alias', feature.aliases || [], 900, 480],
    ['breadcrumb', feature.breadcrumb || [], 700, 320],
    ['summary', feature.summary, 450, 220],
  ]
  for (const [kind, raw, exact, contains] of checks) {
    const values = Array.isArray(raw) ? raw : [raw]
    const best = Math.max(0, ...values.map((value) => scoreText(query, value, exact, contains)))
    if (best) {
      score += best
      reasons.push(kind)
    }
  }
  return { score, reasons }
}

function routeScore(route, query) {
  let score = 0
  const phrases = []
  for (const row of route.phrases || []) {
    const value = typeof row === 'string' ? row : row.phrase
    const matched = scoreText(query, value, 800, 400)
    if (matched) {
      score = Math.max(score, matched)
      phrases.push(value)
    }
  }
  return { score, phrases }
}

function symbolScore(symbol, query) {
  return Math.max(
    scoreText(query, symbol.symbol, 1400, 700),
    scoreText(query, symbol.class_fqn, 1100, 600),
    scoreText(query, symbol.simple_name, 1000, 550),
  )
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))]
}

function extractDocumentRefs(values) {
  const refs = []
  const pattern = /(wiki\/features\/[^\r\n）)】》'"`]+?\.md(?:#[^\r\n）)】》'"`]+)?)/gu
  for (const value of values) {
    for (const match of String(value || '').replace(/\\/g, '/').matchAll(pattern)) {
      if (match[1]) refs.push(match[1].trim())
    }
  }
  return uniqueStrings(refs)
}

export function searchKnowledge(args = {}, options = {}) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const rawQueries = uniqueStrings([
    String(args.query || '').trim(),
    ...(Array.isArray(args.queries) ? args.queries.map((value) => String(value || '').trim()) : []),
  ])
  const queries = rawQueries.map(normalizeText)
  if (!queries.length) throw new Error('knowledge_query_required')
  const config = loadRuntimeConfig(options)
  const source = resolveSource(projectId, args.source_id, config)
  const sourceId = source.id
  const targets = sourceTargets(source, projectId, args.target)
  const { paths, catalog, symbols } = loadManifest(source)
  const eligible = new Map(
    (catalog.features || [])
      .filter((feature) => intersects(feature.applies_to || [], targets))
      .map((feature) => [feature.feature_id, feature]),
  )
  const ranked = new Map()
  const ensure = (featureId) => {
    const feature = eligible.get(featureId)
    if (!feature) return null
    if (!ranked.has(featureId)) {
      const base = queries
        .map((query) => featureScore(feature, query))
        .sort((left, right) => right.score - left.score)[0] || { score: 0, reasons: [] }
      ranked.set(featureId, {
        feature,
        score: base.score,
        reasons: base.reasons,
        routes: [],
        symbols: [],
        routeScore: 0,
        symbolScore: 0,
      })
    }
    return ranked.get(featureId)
  }

  for (const featureId of eligible.keys()) ensure(featureId)
  for (const symbol of symbols) {
    if (!intersects(symbol.targets || [], targets)) continue
    const score = Math.max(...queries.map((query) => symbolScore(symbol, query)))
    if (!score) continue
    const hit = ensure(symbol.feature_id)
    if (!hit) continue
    hit.score += Math.max(0, score - hit.symbolScore)
    hit.symbolScore = Math.max(hit.symbolScore, score)
    hit.reasons.push('symbol')
    const symbolHit = {
      symbol: symbol.symbol,
      class_fqn: symbol.class_fqn,
      simple_name: symbol.simple_name,
      targets: symbol.targets || [],
      read: symbol.read || [],
      match_score: score,
    }
    const symbolKey = JSON.stringify(symbolHit)
    if (!hit.symbols.some((entry) => JSON.stringify(entry) === symbolKey)) hit.symbols.push(symbolHit)
  }

  const requestedDocRefs = uniqueStrings(
    [
      ...(Array.isArray(args.doc_refs) ? args.doc_refs : [args.doc_ref]),
      ...extractDocumentRefs(rawQueries),
    ].map((value) => String(value || '').trim()).filter(Boolean),
  )
  for (const docRef of requestedDocRefs) {
    const docPath = splitDocRef(docRef).rel
    for (const feature of eligible.values()) {
      if (!featureOwnsDocument(feature, docPath)) continue
      const hit = ensure(feature.feature_id)
      if (!hit) continue
      hit.score = Math.max(hit.score, 1400)
      hit.reasons.push('doc_ref')
    }
  }

  const strongCandidates = [...ranked.values()]
    .filter((item) => item.score >= 300)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map((item) => item.feature.feature_id)
  const routeBundle = strongCandidates.length
    ? loadFeatureRoutes(paths, catalog, strongCandidates)
    : loadAllRouteShards(paths)
  for (const route of routeBundle.routes) {
    if (!intersects(route.targets || [], targets)) continue
    const hit = ensure(route.feature_id)
    if (!hit) continue
    const matchesDoc = requestedDocRefs.some((docRef) =>
      (route.read || []).some((ref) => sameDocumentPath(ref, docRef)))
    const matched = queries
      .map((query) => routeScore(route, query))
      .sort((left, right) => right.score - left.score)[0] || { score: 0, phrases: [] }
    if (!matched.score && !matchesDoc) continue
    const routeScoreValue = matchesDoc ? 1300 : matched.score
    hit.score += Math.max(0, routeScoreValue - hit.routeScore)
    hit.routeScore = Math.max(hit.routeScore, routeScoreValue)
    hit.reasons.push(matchesDoc ? 'doc_ref' : `route:${route.intent || 'unknown'}`)
    const routeHit = {
      intent: route.intent || null,
      targets: route.targets || [],
      read: route.read || [],
      matched_phrases: matched.phrases,
    }
    const routeKey = JSON.stringify(routeHit)
    if (!hit.routes.some((entry) => JSON.stringify(entry) === routeKey)) hit.routes.push(routeHit)
  }

  const results = [...ranked.values()]
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const exactSymbolDelta = Number(b.symbolScore >= EXACT_SYMBOL_MATCH_SCORE)
        - Number(a.symbolScore >= EXACT_SYMBOL_MATCH_SCORE)
      return exactSymbolDelta
        || b.score - a.score
        || String(a.feature.title).localeCompare(String(b.feature.title), 'zh-CN')
    })
    .slice(0, clampLimit(args.limit))
    .map((item) => ({
      feature_id: item.feature.feature_id,
      title: item.feature.title,
      aliases: item.feature.aliases || [],
      summary: item.feature.summary || '',
      breadcrumb: item.feature.breadcrumb || [],
      applies_to: (item.feature.applies_to || []).filter((target) => targets.includes(target)),
      confidence: item.feature.confidence || null,
      canonical_readme: item.feature.canonical_readme || item.feature.canonical_entry || null,
      score: item.score,
      match_reasons: uniqueStrings(item.reasons),
      routes: item.routes.slice(0, 6),
      symbols: item.symbols
        .sort((left, right) => right.match_score - left.match_score)
        .slice(0, 6),
    }))

  return {
    project_id: projectId,
    source_id: sourceId,
    query: args.query,
    queries,
    targets,
    retrieval: {
      strategy: strongCandidates.length ? 'candidate_route_shards' : 'route_fallback',
      route_shards: routeBundle.shards,
    },
    result_count: results.length,
    results,
  }
}

function splitDocRef(docRef) {
  const raw = String(docRef || '').trim().replace(/\\/g, '/')
  if (!raw) throw new Error('knowledge_doc_ref_required')
  const hash = raw.indexOf('#')
  const rel = hash >= 0 ? raw.slice(0, hash) : raw
  const anchorRaw = hash >= 0 ? raw.slice(hash + 1) : ''
  let anchor = anchorRaw
  try {
    anchor = decodeURIComponent(anchorRaw)
  } catch {
    throw new Error('knowledge_doc_ref_invalid_encoding')
  }
  const withExtension = path.posix.extname(rel) ? rel : `${rel}.md`
  const normalized = path.posix.normalize(withExtension).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error('knowledge_doc_ref_invalid')
  }
  return { rel: normalized, anchor: anchor.trim(), normalizedRef: `${normalized}${anchor ? `#${anchor}` : ''}` }
}

function referenceKey(docRef) {
  const parsed = splitDocRef(docRef)
  return `${parsed.rel}${parsed.anchor ? `#${normalizeText(parsed.anchor)}` : ''}`
}

function sameDocumentPath(left, right) {
  return splitDocRef(left).rel === splitDocRef(right).rel
}

function featureOwnsDocument(feature, docPath) {
  const normalized = splitDocRef(docPath).rel
  for (const ref of [feature.canonical_entry, feature.canonical_readme, feature.route_owner_readme]) {
    if (!ref) continue
    const ownerPath = splitDocRef(ref).rel
    const ownerDir = path.posix.dirname(ownerPath)
    if (normalized === ownerPath || normalized.startsWith(`${ownerDir}/`)) return true
  }
  return false
}

function featureForDocument(catalog, docRef, targets) {
  const docPath = splitDocRef(docRef).rel
  const matches = (catalog.features || [])
    .filter((feature) => intersects(feature.applies_to || [], targets))
    .filter((feature) => featureOwnsDocument(feature, docPath))
    .sort((left, right) => {
      const leftRef = left.canonical_readme || left.canonical_entry || ''
      const rightRef = right.canonical_readme || right.canonical_entry || ''
      return path.posix.dirname(rightRef).length - path.posix.dirname(leftRef).length
    })
  return matches[0] || null
}

function selectedRoutes(routes, featureId, targets, intent) {
  const requestedIntent = normalizeText(intent)
  const matched = routes.filter((route) =>
    route.feature_id === featureId &&
    intersects(route.targets || [], targets) &&
    (!requestedIntent || normalizeText(route.intent) === requestedIntent),
  )
  const unique = new Map()
  for (const route of matched) {
    const key = JSON.stringify({
      intent: route.intent || null,
      targets: route.targets || [],
      read: route.read || [],
    })
    if (!unique.has(key)) unique.set(key, route)
  }
  return [...unique.values()]
}

function allowedReferences(catalog, routes, symbols, targets) {
  const allowed = new Set()
  const eligibleIds = new Set()
  for (const feature of catalog.features || []) {
    if (!intersects(feature.applies_to || [], targets)) continue
    eligibleIds.add(feature.feature_id)
    for (const ref of [feature.canonical_entry, feature.canonical_readme, feature.route_owner_readme]) {
      if (ref) allowed.add(referenceKey(ref))
    }
  }
  for (const route of routes) {
    if (!eligibleIds.has(route.feature_id) || !intersects(route.targets || [], targets)) continue
    for (const ref of [...(route.read || []), ...(route.source_chain || [])]) {
      if (ref) allowed.add(referenceKey(ref))
    }
  }
  for (const symbol of symbols) {
    if (!eligibleIds.has(symbol.feature_id) || !intersects(symbol.targets || [], targets)) continue
    for (const ref of symbol.read || []) {
      if (ref) allowed.add(referenceKey(ref))
    }
  }
  return allowed
}

function resolveDocumentPath(contentRoot, docRef) {
  const parsed = splitDocRef(docRef)
  if (path.posix.extname(parsed.rel).toLowerCase() !== '.md') {
    throw new Error('knowledge_doc_type_not_allowed')
  }
  const absolute = path.resolve(contentRoot, ...parsed.rel.split('/'))
  const relative = path.relative(contentRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('knowledge_doc_ref_invalid')
  }
  return { ...parsed, absolute }
}

function headingText(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  if (!match) return null
  return { level: match[1].length, text: match[2].replace(/\s+#+\s*$/, '').trim() }
}

function extractSection(markdown, anchor) {
  if (!anchor) return { content: markdown, section: null }
  const wanted = normalizeText(anchor).replace(/[-_]+/g, ' ')
  const lines = markdown.split(/\r?\n/g)
  let start = -1
  let level = 0
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingText(lines[index])
    if (!heading) continue
    const comparable = normalizeText(heading.text).replace(/[-_]+/g, ' ')
    if (comparable === wanted) {
      start = index
      level = heading.level
      break
    }
  }
  if (start < 0) throw new Error(`knowledge_section_not_found:${anchor}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = headingText(lines[index])
    if (heading && heading.level <= level) {
      end = index
      break
    }
  }
  return { content: lines.slice(start, end).join('\n').trim(), section: anchor }
}

function readDocument(paths, docRef, maxContentChars) {
  const resolved = resolveDocumentPath(paths.contentRoot, docRef)
  if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
    throw new Error(`knowledge_document_not_found:${resolved.rel}`)
  }
  const selected = extractSection(fs.readFileSync(resolved.absolute, 'utf8'), resolved.anchor)
  const cap = Math.max(1000, Number(maxContentChars || DEFAULT_MAX_CONTENT_CHARS))
  const truncated = selected.content.length > cap
  return {
    doc_ref: resolved.normalizedRef,
    section: selected.section,
    content: truncated ? selected.content.slice(0, cap) : selected.content,
    truncated,
  }
}

export function readKnowledge(args = {}, options = {}) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const config = loadRuntimeConfig(options)
  const source = resolveSource(projectId, args.source_id, config)
  const sourceId = source.id
  const targets = sourceTargets(source, projectId, args.target)
  const { paths, catalog, symbols } = loadManifest(source)
  const featureId = String(args.feature_id || '').trim()
  const docRef = String(args.doc_ref || '').trim()
  if (!featureId && !docRef) throw new Error('knowledge_feature_or_doc_ref_required')

  if (docRef) {
    const owner = featureForDocument(catalog, docRef, targets)
    const routeBundle = owner
      ? loadFeatureRoutes(paths, catalog, [owner.feature_id])
      : loadAllRouteShards(paths)
    const routes = routeBundle.routes
    const allowed = allowedReferences(catalog, routes, symbols, targets)
    if (!allowed.has(referenceKey(docRef))) throw new Error('knowledge_doc_ref_not_allowed')
    return {
      project_id: projectId,
      source_id: sourceId,
      targets,
      document: readDocument(paths, docRef, args.max_content_chars),
      citations: [{ source_id: sourceId, doc_ref: splitDocRef(docRef).normalizedRef }],
    }
  }

  const feature = (catalog.features || []).find((entry) => entry.feature_id === featureId)
  if (!feature || !intersects(feature.applies_to || [], targets)) {
    throw new Error(`knowledge_feature_not_found:${featureId}`)
  }
  const { routes } = loadFeatureRoutes(paths, catalog, [featureId])
  const routeRows = selectedRoutes(routes, featureId, targets, args.intent)
  const canonicalRef = feature.canonical_readme || feature.canonical_entry
  const document = canonicalRef ? readDocument(paths, canonicalRef, args.max_content_chars) : null
  return {
    project_id: projectId,
    source_id: sourceId,
    targets,
    feature: {
      feature_id: feature.feature_id,
      title: feature.title,
      aliases: feature.aliases || [],
      summary: feature.summary || '',
      breadcrumb: feature.breadcrumb || [],
      applies_to: (feature.applies_to || []).filter((target) => targets.includes(target)),
      confidence: feature.confidence || null,
      updated: feature.updated || null,
    },
    routes: routeRows.map((route) => ({
      intent: route.intent || null,
      targets: route.targets || [],
      read: route.read || [],
      source_chain: route.source_chain || [],
    })),
    document,
    citations: canonicalRef ? [{ source_id: sourceId, doc_ref: splitDocRef(canonicalRef).normalizedRef }] : [],
  }
}

function targetPlatform(target) {
  const value = normalizeTarget(target).toLowerCase()
  if (value.endsWith('.android')) return 'android'
  if (value.endsWith('.harmony') || value.endsWith('.harmonyos')) return 'harmonyos'
  return 'unknown'
}

function refsForPlatform(routes, symbols, platform) {
  const routeRefs = routes.flatMap((route) => {
    const routeTargets = (route.targets || []).filter((target) => targetPlatform(target) === platform)
    if (!routeTargets.length) return []
    return (route.read || []).filter((ref) => ref.includes('/code_map/'))
  })
  const symbolRefs = symbols.flatMap((symbol) => {
    if (!(symbol.targets || []).some((target) => targetPlatform(target) === platform)) return []
    return symbol.read || []
  })
  return uniqueStrings([...routeRefs, ...symbolRefs].map((ref) => splitDocRef(ref).normalizedRef))
}

function symbolsForPlatform(symbols, platform, preferred = [], limit = 12) {
  const preferredSymbols = new Set(preferred.map((symbol) => symbol.symbol).filter(Boolean))
  const preferredClasses = new Set(preferred.map((symbol) => symbol.class_fqn).filter(Boolean))
  const preference = (symbol) =>
    preferredSymbols.has(symbol.symbol) ? 2 : preferredClasses.has(symbol.class_fqn) ? 1 : 0
  return [...symbols]
    .filter((symbol) => (symbol.targets || []).some((target) => targetPlatform(target) === platform))
    .sort((left, right) => preference(right) - preference(left))
    .slice(0, limit)
    .map((symbol) => ({
      symbol: symbol.symbol || null,
      class_fqn: symbol.class_fqn || null,
      simple_name: symbol.simple_name || null,
      status: symbol.status || null,
      revision: symbol.revision || null,
      read: symbol.read || [],
    }))
}

/**
 * Resolve a project-scoped manifest feature into a compact L1 context. The manifest
 * stays the only runtime index; Markdown remains the human-authored fact source.
 */
export function resolveKnowledgeFeatureContext(args = {}, options = {}) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const config = loadRuntimeConfig(options)
  const source = resolveSource(projectId, args.source_id, config)
  const sourceId = source.id
  const targets = sourceTargets(source, projectId, args.target)
  const { paths, catalog, symbols } = loadManifest(source)
  const requestedFeatureId = String(args.feature_id || '').trim()
  const eligibleFeatures = (catalog.features || []).filter((feature) =>
    intersects(feature.applies_to || [], targets),
  )

  let feature = requestedFeatureId
    ? eligibleFeatures.find((entry) => entry.feature_id === requestedFeatureId)
    : null
  let matchBy = feature ? 'feature_id' : null
  let score = feature ? 1000 : 0
  const queries = uniqueStrings([
    requestedFeatureId,
    String(args.query || '').trim(),
    ...(Array.isArray(args.hints) ? args.hints.map((value) => String(value || '').trim()) : []),
  ])
  const requestedDocRefs = uniqueStrings(
    (Array.isArray(args.doc_refs) ? args.doc_refs : [args.doc_ref])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )
  let matchedResult = null

  if (!feature) {
    const result = searchKnowledge({
      project_id: projectId,
      source_id: sourceId,
      query: queries[0],
      queries: queries.slice(1),
      doc_refs: requestedDocRefs,
      target: args.target,
      limit: 1,
    }, { config })
    const candidate = result.results[0]
    if (candidate && candidate.score >= Number(args.min_score || 300)) {
      feature = eligibleFeatures.find((entry) => entry.feature_id === candidate.feature_id) || null
      matchedResult = candidate
      if (feature) {
        matchBy = candidate.match_reasons.includes('doc_ref')
          ? 'doc_ref'
          : candidate.match_reasons.includes('symbol')
            ? 'symbol'
            : 'query'
        score = candidate.score
      }
    }
  }

  if (!feature) {
    return {
      hit: false,
      project_id: projectId,
      source_id: sourceId,
      requested_feature_id: requestedFeatureId || null,
      queries,
      targets,
    }
  }

  const routeBundle = loadFeatureRoutes(paths, catalog, [feature.feature_id])
  const featureRoutes = selectedRoutes(routeBundle.routes, feature.feature_id, targets, args.intent)
  const featureSymbols = symbols.filter((symbol) =>
    symbol.feature_id === feature.feature_id && intersects(symbol.targets || [], targets),
  )
  const canonicalRef = feature.canonical_readme || feature.canonical_entry
  const knownFeatureRefs = uniqueStrings([
    canonicalRef,
    ...featureRoutes.flatMap((route) => route.read || []),
    ...featureSymbols.flatMap((symbol) => symbol.read || []),
  ])
  const exactRequestedRefs = requestedDocRefs.filter((docRef) =>
    knownFeatureRefs.some((knownRef) => sameDocumentPath(knownRef, docRef)),
  )
  const explicitDocRefs = uniqueStrings(
    [
      ...exactRequestedRefs,
      ...requestedDocRefs.flatMap((docRef) => [
        ...featureRoutes.flatMap((route) => (route.read || []).filter((ref) => sameDocumentPath(ref, docRef))),
        ...featureSymbols.flatMap((symbol) => (symbol.read || []).filter((ref) => sameDocumentPath(ref, docRef))),
      ]),
    ],
  )
  const routedRefs = explicitDocRefs.length
    ? explicitDocRefs
    : uniqueStrings([
        ...(matchedResult?.routes || []).flatMap((route) => route.read || []),
        ...(matchedResult?.symbols || []).flatMap((symbol) => symbol.read || []),
      ])
  const selectedRefs = (routedRefs.length ? routedRefs : [canonicalRef]).filter(Boolean).slice(0, MAX_CONTEXT_DOCUMENTS)
  const totalContentCap = Math.min(
    Math.max(1000, Number(args.max_content_chars || DEFAULT_CONTEXT_CONTENT_CHARS)),
    8_000,
  )
  let remaining = totalContentCap
  const documents = []
  for (const docRef of selectedRefs) {
    if (remaining <= 0) break
    const document = readDocument(paths, docRef, Math.min(remaining, 3_000))
    const content = document.content.slice(0, remaining)
    documents.push({ ...document, content, truncated: document.truncated || content.length < document.content.length })
    remaining -= content.length
  }
  const overview = documents[0] || null
  const preferredSymbols = (matchedResult?.symbols || []).slice(0, 1)
  const androidSymbols = symbolsForPlatform(featureSymbols, 'android', preferredSymbols)
  const harmonySymbols = symbolsForPlatform(featureSymbols, 'harmonyos', preferredSymbols)
  const androidCodeMaps = refsForPlatform(featureRoutes, featureSymbols, 'android')
  const harmonyCodeMaps = refsForPlatform(featureRoutes, featureSymbols, 'harmonyos')

  return {
    hit: true,
    project_id: projectId,
    source_id: sourceId,
    requested_feature_id: requestedFeatureId || null,
    feature_id: feature.feature_id,
    match_by: matchBy,
    score,
    targets,
    feature: {
      feature_id: feature.feature_id,
      title: feature.title,
      aliases: feature.aliases || [],
      summary: feature.summary || '',
      breadcrumb: feature.breadcrumb || [],
      applies_to: (feature.applies_to || []).filter((target) => targets.includes(target)),
      confidence: feature.confidence || null,
      updated: feature.updated || null,
    },
    overview,
    documents,
    retrieval: {
      strategy: matchBy === 'doc_ref' || matchBy === 'symbol' ? 'manifest_exact_route' : 'manifest_feature_route',
      route_shards: routeBundle.shards,
      read_refs: documents.map((document) => document.doc_ref),
    },
    routes: featureRoutes.map((route) => ({
      intent: route.intent || null,
      targets: route.targets || [],
      read: route.read || [],
      source_chain: route.source_chain || [],
    })),
    platforms: {
      android: { symbols: androidSymbols, code_map_refs: androidCodeMaps },
      harmonyos: { symbols: harmonySymbols, code_map_refs: harmonyCodeMaps },
    },
    cross_platform_ready: androidCodeMaps.length > 0 && harmonyCodeMaps.length > 0,
    citations: uniqueStrings([
      ...documents.map((document) => document.doc_ref),
      ...androidCodeMaps,
      ...harmonyCodeMaps,
    ]).map((docRef) => ({ source_id: sourceId, doc_ref: splitDocRef(docRef).normalizedRef })),
  }
}

export function resolveKnowledgeCounterpart(args = {}, options = {}) {
  const fromPlatform = args.from_platform === 'harmonyos' ? 'harmonyos' : 'android'
  const toPlatform = fromPlatform === 'android' ? 'harmonyos' : 'android'
  const context = resolveKnowledgeFeatureContext({
    ...args,
    query: args.symbol || args.query,
  }, options)
  if (!context.hit) return { ...context, from_platform: fromPlatform, to_platform: toPlatform }

  const from = context.platforms[fromPlatform]
  const counterpart = context.platforms[toPlatform]
  const hasCounterpart = counterpart.symbols.length > 0 || counterpart.code_map_refs.length > 0
  const firstAndroid = context.platforms.android.symbols[0] || {}
  const firstHarmony = context.platforms.harmonyos.symbols[0] || {}
  return {
    hit: hasCounterpart,
    project_id: context.project_id,
    source_id: context.source_id,
    requested_feature_id: context.requested_feature_id,
    feature_id: context.feature_id,
    relation_type: 'feature_code_map',
    match_by: context.match_by,
    from_platform: fromPlatform,
    to_platform: toPlatform,
    title: context.feature.title,
    confidence: context.feature.confidence || 'medium',
    status: hasCounterpart ? 'reviewed' : 'counterpart_not_registered',
    android: {
      entry_simple: firstAndroid.simple_name || null,
      entry_fqn: firstAndroid.class_fqn || firstAndroid.symbol || null,
      code_map_refs: context.platforms.android.code_map_refs,
      symbols: context.platforms.android.symbols,
    },
    harmonyos: {
      entry: firstHarmony.class_fqn || firstHarmony.symbol || firstHarmony.simple_name || null,
      code_map_refs: context.platforms.harmonyos.code_map_refs,
      symbols: context.platforms.harmonyos.symbols,
    },
    from: {
      symbols: from.symbols,
      code_map_refs: from.code_map_refs,
    },
    counterpart: {
      symbols: counterpart.symbols,
      code_map_refs: counterpart.code_map_refs,
    },
    citations: context.citations,
  }
}

export function resetKnowledgeSourceCache() {
  FILE_CACHE.clear()
}
