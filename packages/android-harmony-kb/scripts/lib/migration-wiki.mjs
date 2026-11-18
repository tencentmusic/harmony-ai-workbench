import fs from 'fs'
import path from 'path'
import { findWorkspaceApp, listPortalKnowledgeBases, loadWorkspaceConfig } from '@kugou/workspace-config'
import { KB_ROOT } from './paths.mjs'

const MAX_NAV_EXCERPT = 480
const RUNTIME_INDEX_TTL_MS = 30_000
const runtimeIndexCache = new Map()

function normalizeSubpath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function resolveMigrationSource(env = process.env, sourceId = '') {
  const workspace = loadWorkspaceConfig({ startDir: KB_ROOT, env })
  const sources = listPortalKnowledgeBases('migration', workspace)
  const source = sourceId ? sources.find((item) => item.id === sourceId) : sources[0]
  if (!source) throw new Error(sourceId ? `migration_source_not_found:${sourceId}` : 'migration_source_missing')
  const root = source?.root || ''
  const contentRoot = normalizeSubpath(source?.query?.content_root)
  const resolved = contentRoot ? path.resolve(root, ...contentRoot.split('/')) : root
  if (!resolved || !fs.existsSync(resolved)) throw new Error('migration_cases_root_missing')
  return { workspace, source, contentRoot: resolved }
}

/** @returns {string} 迁移案例内容根目录 */
export function resolveHarmonyDocsRoot(env = process.env, sourceId = '') {
  return resolveMigrationSource(env, sourceId).contentRoot.replace(/\\/g, '/')
}

function walkMarkdown(root, current = root, output = []) {
  for (const item of fs.readdirSync(current, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue
    const absolute = path.join(current, item.name)
    if (item.isDirectory()) walkMarkdown(root, absolute, output)
    else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) {
      output.push(path.relative(root, absolute).replace(/\\/g, '/'))
    }
  }
  return output
}

function titleFromMarkdown(text, fallback) {
  const heading = String(text || '').match(/^#\s+(.+?)\s*$/m)
  return heading?.[1]?.trim() || fallback
}

function targetProjectId(docRef, source, workspace) {
  const normalized = normalizeDocRef(docRef)
  const target = Object.entries(source?.portal?.path_targets || {})
    .map(([prefix, appId]) => [normalizeSubpath(prefix), String(appId || '').trim()])
    .filter(([prefix, appId]) => prefix && appId && (normalized === prefix || normalized.startsWith(`${prefix}/`)))
    .sort(([left], [right]) => right.length - left.length)[0]
  if (!target) return ''
  return findWorkspaceApp(target[1], workspace)?.project_id || ''
}

function buildRuntimeIndex(env, sourceId = '') {
  const { workspace, source, contentRoot } = resolveMigrationSource(env, sourceId)
  const treeRoot = normalizeSubpath(source?.portal?.tree_root)
  const scanRoot = treeRoot ? path.resolve(contentRoot, ...treeRoot.split('/')) : contentRoot
  const prefix = treeRoot ? `${treeRoot}/` : ''
  const entries = walkMarkdown(scanRoot).map((treePath) => {
    const docRef = normalizeDocRef(`${prefix}${treePath}`)
    const absolute = path.resolve(contentRoot, ...docRef.split('/'))
    const markdown = fs.readFileSync(absolute, 'utf8')
    const projectId = targetProjectId(docRef, source, workspace)
    const fallbackTitle = path.posix.basename(docRef, '.md') === 'README'
      ? path.posix.basename(path.posix.dirname(docRef))
      : path.posix.basename(docRef, '.md')
    return {
      doc_id: `${source.id}:${docRef}`,
      source_id: source.id,
      kind: docRef.includes('/delegates/') ? 'delegate' : 'document',
      project_id: projectId,
      feature_id: null,
      doc_ref: docRef,
      doc_scope: 'android-migration',
      path_hint: pathHintFromDocRef(docRef, treeRoot),
      parent_title: null,
      title: titleFromMarkdown(markdown, fallbackTitle),
      tier: 'catalog',
      nav_excerpt: extractNavFromMarkdown(markdown),
      sections: extractSections(markdown),
      child_docs: [],
      android_classes: [],
      harmony_classes: [],
      keywords: [],
    }
  })
  return {
    schema_version: '2.0',
    generated_at: new Date().toISOString(),
    source_id: source.id,
    document_root: treeRoot,
    docs_root: contentRoot.replace(/\\/g, '/'),
    entry_count: entries.length,
    entries,
  }
}

export function loadMigrationWikiIndex(env = process.env, sourceId = '') {
  const key = sourceId || '__default__'
  const hit = runtimeIndexCache.get(key)
  if (hit?.expiresAt > Date.now()) return hit.value
  const value = buildRuntimeIndex(env, sourceId)
  runtimeIndexCache.set(key, { expiresAt: Date.now() + RUNTIME_INDEX_TTL_MS, value })
  return value
}

function tokenize(text) {
  const raw = String(text || '').toLowerCase()
  const parts = raw.match(/[\u4e00-\u9fff]+|[a-z0-9_.]+/gi) || []
  return parts.filter((p) => p.length >= 2 || /^[a-z0-9]/i.test(p))
}

function scoreEntry(entry, tokens) {
  let score = 0
  const title = String(entry.title || '').toLowerCase()
  const featureId = String(entry.feature_id || '').toLowerCase()
  const docId = String(entry.doc_id || '').toLowerCase()
  const keywordSet = new Set((entry.keywords || []).map((k) => String(k).toLowerCase()))

  for (const tok of tokens) {
    const t = tok.toLowerCase()
    if (docId === t || featureId === t) score += 120
    else if (title.includes(t)) score += 40
    else if (featureId.includes(t)) score += 35
    else if (keywordSet.has(t)) score += 30
    else if ((entry.android_classes || []).some((c) => String(c).toLowerCase().includes(t))) score += 45
    else if ((entry.harmony_classes || []).some((c) => String(c).toLowerCase().includes(t))) score += 42
    else if ((entry.sections || []).some((s) => String(s).toLowerCase().includes(t))) score += 12
    else if (String(entry.nav_excerpt || '').toLowerCase().includes(t)) score += 8
    else if (String(entry.doc_ref || '').toLowerCase().includes(t)) score += 5
  }
  return score
}

function findEntry(index, { doc_id, feature_id, doc_ref, project_id = 'demo-project' }) {
  const entries = index.entries || []
  if (doc_id) {
    const hit = entries.find((e) => e.doc_id === doc_id && e.project_id === project_id)
    if (hit) return hit
  }
  if (feature_id) {
    const hit = entries.find(
      (e) => e.feature_id === feature_id && e.project_id === project_id && e.kind === 'page',
    )
    if (hit) return hit
  }
  if (doc_ref) {
    const norm = normalizeDocRef(doc_ref)
    const hit = entries.find((e) => normalizeDocRef(e.doc_ref) === norm)
    if (hit) return hit
  }
  return null
}

export function normalizeDocRef(docRef) {
  return String(docRef || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function assertIndexedDocRef(index, docRef) {
  const norm = normalizeDocRef(docRef)
  if (norm.includes('..')) throw new Error('invalid_doc_ref')
  const hit = (index.entries || []).find((e) => normalizeDocRef(e.doc_ref) === norm)
  if (!hit) throw new Error(`doc_ref_not_in_index:${norm}`)
  return hit
}

function resolveDocAbsolute(docsRoot, docRef) {
  const norm = normalizeDocRef(docRef)
  if (!norm || norm.includes('..')) throw new Error('invalid_doc_ref')
  const abs = path.resolve(docsRoot, norm.split('/').join(path.sep))
  const root = path.resolve(docsRoot)
  if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('doc_path_escape')
  if (!fs.existsSync(abs)) throw new Error(`doc_file_missing:${norm}`)
  return { abs, norm }
}


function extractNavFromMarkdown(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let inBlock = false
  for (const line of lines) {
    if (/^---\s*$/.test(line) && out.length > 3) break
    if (/^##\s/.test(line) && out.length > 8) break
    out.push(line)
    inBlock = true
    if (out.join('\n').length > MAX_NAV_EXCERPT * 2) break
  }
  const joined = out.join('\n').trim()
  return joined.length > MAX_NAV_EXCERPT ? `${joined.slice(0, MAX_NAV_EXCERPT)}…` : joined
}

function extractSections(text) {
  const sections = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) sections.push(m[1].trim())
  }
  return sections
}

function extractHarmonySections(text) {
  const sections = extractSections(text)
  const harmonyTitles = sections.filter((s) => /鸿蒙|Harmony|harmonyos|\.ets/i.test(s))
  if (!harmonyTitles.length) return { sections: harmonyTitles, content: '' }
  const parts = []
  for (const title of harmonyTitles) {
    try {
      parts.push(`## ${title}\n\n${extractSectionBody(text, title)}`)
    } catch {
      /* skip missing */
    }
  }
  return { sections: harmonyTitles, content: parts.join('\n\n').trim() }
}

export function pathHintFromDocRef(docRef, documentRoot = '') {
  const rel = normalizeDocRef(docRef)
  const prefix = documentRoot ? `${normalizeDocRef(documentRoot)}/` : ''
  const tail = prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel
  return tail.replace(/\/README\.md$/, '').replace(/\.md$/, '')
}

function extractSectionBody(text, sectionTitle) {
  const wanted = String(sectionTitle || '').trim()
  if (!wanted) throw new Error('section_required')
  const lines = text.split(/\r?\n/)
  let start = -1
  let level = 2
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/)
    if (!m) continue
    const title = m[2].trim()
    if (title === wanted || title.includes(wanted) || wanted.includes(title)) {
      start = i + 1
      level = m[1].length
      break
    }
  }
  if (start < 0) throw new Error(`section_not_found:${wanted}`)
  const buf = []
  for (let i = start; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{2,6})\s+/)
    if (hm && hm[1].length <= level) break
    buf.push(lines[i])
  }
  return buf.join('\n').trim()
}

/**
 * @param {{ query: string, project_id?: string, limit?: number }} args
 */
export function kbWikiSearch(args, env = process.env) {
  const index = loadMigrationWikiIndex(env, String(args.source_id || '').trim())
  const projectId = String(args.project_id || 'demo-project').trim()
  const docScope = args.doc_scope ? String(args.doc_scope).trim() : null
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20)
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query_required')

  const tokens = tokenize(query)
  if (!tokens.length) throw new Error('query_token_empty')

  const ranked = (index.entries || [])
    .filter((e) => !e.project_id || e.project_id === projectId)
    .filter((e) => !docScope || e.doc_scope === docScope)
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return {
    schema_version: '1.0',
    kind: 'wiki_search_result',
    query,
    project_id: projectId,
    result_count: ranked.length,
    next: 'Call kb_wiki_read with doc_id or feature_id and mode=nav before mode=detail/section.',
    doc_scopes_available: ['android-migration', 'harmony-native'],
    default_doc_scope: 'android-migration',
    results: ranked.map(({ entry, score }) => ({
      doc_id: entry.doc_id,
      source_id: entry.source_id,
      feature_id: entry.feature_id || null,
      kind: entry.kind,
      doc_scope: entry.doc_scope || 'android-migration',
      title: entry.title,
      doc_ref: entry.doc_ref,
      path_hint: entry.path_hint || pathHintFromDocRef(entry.doc_ref, index.document_root),
      parent_title: entry.parent_title || null,
      score,
      nav_excerpt: String(entry.nav_excerpt || '').slice(0, MAX_NAV_EXCERPT),
      sections: (entry.sections || []).slice(0, 24),
      child_docs: (entry.child_docs || []).slice(0, 12),
      next: entry.kind === 'page' ? 'nav' : 'section',
    })),
  }
}

/**
 * @param {{ doc_id?: string, feature_id?: string, doc_ref?: string, mode?: string, section?: string, child_ref?: string, project_id?: string }} args
 */
export function kbWikiRead(args, env = process.env) {
  const sourceId = String(args.source_id || '').trim()
  const index = loadMigrationWikiIndex(env, sourceId)
  const projectId = String(args.project_id || 'demo-project').trim()
  const mode = String(args.mode || 'nav').trim().toLowerCase()
  const docsRoot = resolveHarmonyDocsRoot(env, sourceId || index.source_id)

  let entry = findEntry(index, {
    doc_id: args.doc_id,
    feature_id: args.feature_id,
    doc_ref: args.doc_ref,
    project_id: projectId,
  })

  if (!entry && args.doc_ref) {
    entry = assertIndexedDocRef(index, args.doc_ref)
  }
  if (!entry) {
    throw new Error(
      'wiki_doc_not_found: provide doc_id, feature_id, or indexed doc_ref (use kb_wiki_search first)',
    )
  }

  if (mode === 'children') {
    const childRef = args.child_ref ? normalizeDocRef(args.child_ref) : null
    const children = entry.child_docs || []
    if (!childRef) {
      return {
        schema_version: '1.0',
        kind: 'wiki_children',
        doc_id: entry.doc_id,
        title: entry.title,
        children,
        next: 'Pass child_ref from this list with mode=section or mode=detail.',
      }
    }
    const childEntry = assertIndexedDocRef(index, childRef)
    entry = childEntry
  }

  const { abs, norm } = resolveDocAbsolute(docsRoot, entry.doc_ref)
  const text = fs.readFileSync(abs, 'utf8')

  if (mode === 'nav') {
    const nav = extractNavFromMarkdown(text)
    return {
      schema_version: '1.0',
      kind: 'wiki_nav',
      doc_id: entry.doc_id,
      feature_id: entry.feature_id || null,
      title: entry.title,
      doc_ref: norm,
      source: index.source_id,
      sections: extractSections(text),
      child_docs: entry.child_docs || [],
      content: nav,
      next: 'Use mode=section for a specific ## heading, or mode=detail for full markdown.',
    }
  }

  if (mode === 'section') {
    const body = extractSectionBody(text, args.section || '')
    return {
      schema_version: '1.0',
      kind: 'wiki_section',
      doc_id: entry.doc_id,
      feature_id: entry.feature_id || null,
      title: entry.title,
      doc_ref: norm,
      section: args.section,
      content: body,
    }
  }

  if (mode === 'harmony-section') {
    const { sections: harmonySections, content } = extractHarmonySections(text)
    if (!content) {
      throw new Error('harmony_section_not_found: no ## heading matching 鸿蒙/Harmony in this doc')
    }
    return {
      schema_version: '1.0',
      kind: 'wiki_harmony_section',
      doc_id: entry.doc_id,
      feature_id: entry.feature_id || null,
      title: entry.title,
      doc_ref: norm,
      sections: harmonySections,
      content,
      next: 'For .ets implementation use kb_codegraph_search(platform=harmonyos), not wiki detail.',
    }
  }

  if (mode === 'detail') {
    const maxBytes = Number(env.KB_WIKI_MAX_DETAIL_BYTES || 131072)
    let content = text
    let truncated = false
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = content.slice(0, maxBytes)
      truncated = true
    }
    return {
      schema_version: '1.0',
      kind: 'wiki_detail',
      doc_id: entry.doc_id,
      feature_id: entry.feature_id || null,
      title: entry.title,
      doc_ref: norm,
      truncated,
      content,
    }
  }

  throw new Error(`unsupported_mode:${mode}`)
}
