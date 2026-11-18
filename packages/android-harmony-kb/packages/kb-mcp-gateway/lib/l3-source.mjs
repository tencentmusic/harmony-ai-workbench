import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { entriesForProject, parseWorkspacePath, resolveRepoRoot } from './scope-guard.mjs'

const SENSITIVE_RE =
  /(?:^|\/)(?:\.env(?:\.|$)|local\.properties|gradle\.properties|.*\.(?:keystore|jks|pem|p12|pfx)|(?:credentials|secrets?)(?:\.|$))/i
const READABLE_EXT = new Set([
  '.java',
  '.kt',
  '.kts',
  '.xml',
  '.gradle',
  '.pro',
  '.txt',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.properties',
  '.aidl',
  '.rs',
])
const DRAWABLE_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif'])
const DRAWABLE_FILE_RE = /\/res\/drawable[^/]*\/.+\.(webp|png|jpe?g|gif)$/i
const MAX_READ_BYTES = Number(process.env.KB_MCP_MAX_READ_BYTES || 512 * 1024)
const MAX_GREP_MATCHES = Number(process.env.KB_MCP_MAX_GREP_MATCHES || 80)
const MAX_GREP_WALK_FILES = Number(process.env.KB_MCP_GREP_WALK_MAX_FILES || 80000)
const MAX_GREP_WALK_FILES_BROAD = Number(process.env.KB_MCP_GREP_WALK_BROAD_MAX_FILES || 8000)
const DRAWABLE_CACHE_MS = Number(process.env.KB_MCP_DRAWABLE_CACHE_MS || 300000)
const DRAWABLE_CACHE = new Map()

function assertReadablePath(workspacePath) {
  if (SENSITIVE_RE.test(workspacePath)) throw new Error('sensitive_path_blocked')
  const ext = path.extname(workspacePath).toLowerCase()
  if (!READABLE_EXT.has(ext)) throw new Error(`file_type_not_allowed:${ext || 'none'}`)
}

const WORKSPACE_ALIAS_PREFIXES = ['harmony-live-src/', 'harmony-src/', 'live-src/', 'android-src/']

function stripWorkspaceAlias(relPath) {
  let rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  for (const prefix of WORKSPACE_ALIAS_PREFIXES) {
    if (rel.startsWith(prefix)) rel = rel.slice(prefix.length)
  }
  return rel
}

function normalizeRelPath(relPath) {
  return stripWorkspaceAlias(relPath)
}

/** Agent 常省略 workspace alias；按 token prefix 自动补全 */
export function normalizeWorkspacePath(workspacePath, session) {
  let normalized = String(workspacePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) throw new Error('invalid_path')

  const aliases = new Set(session.prefixEntries.map((e) => e.workspaceAlias))
  if (aliases.has(normalized.split('/')[0])) return normalized

  const repoRelative = stripWorkspaceAlias(normalized)
  const entry = session.prefixEntries.find((e) => {
    if (!e.prefix) return true
    return repoRelative === e.prefix || repoRelative.startsWith(`${e.prefix}/`)
  })
  if (entry) return `${entry.workspaceAlias}/${repoRelative}`
  return normalized
}

function resolveGrepPrefix(entry, pathPrefix) {
  const global = normalizeRelPath(pathPrefix)
  const scoped = normalizeRelPath(entry.prefix)
  if (!global) return scoped
  if (!scoped) return global
  if (global === scoped || global.startsWith(`${scoped}/`)) return global
  if (scoped === global || scoped.startsWith(`${global}/`)) return scoped
  return null
}

function grepMatchAllowed(relPath, entry) {
  const rel = normalizeRelPath(relPath)
  if (!entry.prefix) return true
  return rel === entry.prefix || rel.startsWith(`${entry.prefix}/`)
}

function walkFiles(rootDir, relPrefix, maxFiles = 5000) {
  const out = []
  const base = relPrefix ? path.join(rootDir, relPrefix) : rootDir
  if (!fs.existsSync(base)) return out
  const stack = [base]
  const rootNorm = rootDir.replace(/\\/g, '/').replace(/\/+$/, '')
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'build') continue
        stack.push(abs)
      } else if (ent.isFile()) {
        out.push(abs.replace(/\\/g, '/').slice(rootNorm.length + 1))
      }
    }
  }
  return out
}

function grepWithGit(repoRoot, pattern, relPrefix) {
  const args = ['grep', '-n', '-I', '--max-count', String(MAX_GREP_MATCHES)]
  if (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(pattern)) args.push('-F')
  args.push(pattern)
  if (relPrefix) args.push('--', relPrefix)
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return out
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_GREP_MATCHES)
      .map((line) => {
        const m = line.match(/^([^:]+):(\d+):(.*)$/)
        if (!m) return { line }
        return { path: m[1].replace(/\\/g, '/'), line: Number(m[2]), text: m[3] }
      })
  } catch (e) {
    if (e.status === 1) return []
    return null
  }
}

function lineMatchesPattern(line, pattern) {
  if (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(pattern)) {
    return line.includes(pattern)
  }
  try {
    return new RegExp(pattern, 'i').test(line)
  } catch {
    return line.includes(pattern)
  }
}

function grepFallback(repoRoot, pattern, relPrefix, maxFiles = MAX_GREP_WALK_FILES) {
  const files = walkFiles(repoRoot, relPrefix, maxFiles)
  const matches = []
  for (const rel of files) {
    if (matches.length >= MAX_GREP_MATCHES) break
    const ext = path.extname(rel).toLowerCase()
    if (!READABLE_EXT.has(ext)) continue
    const abs = path.join(repoRoot, rel)
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break
      if (lineMatchesPattern(lines[i], pattern)) {
        matches.push({
          path: rel.replace(/\\/g, '/'),
          line: i + 1,
          text: lines[i].slice(0, 500),
        })
      }
    }
  }
  return matches
}

export function sourceGrep(session, args, env = process.env) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const pattern = String(args.pattern || '').trim()
  if (!pattern) throw new Error('pattern_required')
  if (pattern.length > 200) throw new Error('pattern_too_long')

  const pathPrefix = normalizeRelPath(args.path_prefix || '')
  const entries = entriesForProject(session, projectId)
  if (!entries.length) throw new Error('no_scope_for_project')

  const allMatches = []
  const seenPaths = new Set()
  let usedBroadWalk = false

  // 每个 token prefix 单独搜；同一 repo 不能 dedupe（否则会只搜第一个 App 前缀）
  for (const entry of entries) {
    const relPrefix = resolveGrepPrefix(entry, pathPrefix)
    if (relPrefix === null) continue

    const repoRoot = resolveRepoRoot(entry, env)
    const isGit = fs.existsSync(path.join(repoRoot, '.git'))
    const walkCap = relPrefix ? MAX_GREP_WALK_FILES : MAX_GREP_WALK_FILES_BROAD
    let raw = isGit ? grepWithGit(repoRoot, pattern, relPrefix || undefined) : null
    // git grep 跳过 .gitignore 目录；空结果时 fallback 文件 walk
    if (raw === null || raw.length === 0) {
      if (!relPrefix && !pathPrefix) usedBroadWalk = true
      raw = grepFallback(repoRoot, pattern, relPrefix, walkCap)
    }

    for (const m of raw) {
      const rel = typeof m.path === 'string' ? normalizeRelPath(m.path) : null
      if (!rel || !grepMatchAllowed(rel, entry)) continue

      const workspacePath = `${entry.workspaceAlias}/${rel}`
      const key = `${workspacePath}:${m.line || 0}`
      if (seenPaths.has(key)) continue
      seenPaths.add(key)

      allMatches.push({
        path: workspacePath,
        line: m.line,
        text: m.text,
        scope_id: entry.scopeId,
      })
      if (allMatches.length >= MAX_GREP_MATCHES) break
    }
    if (allMatches.length >= MAX_GREP_MATCHES) break
  }

  return {
    project_id: projectId,
    pattern,
    path_prefix: pathPrefix || null,
    scopes_searched: entries.length,
    match_count: allMatches.length,
    truncated: allMatches.length >= MAX_GREP_MATCHES,
    performance_hint: usedBroadWalk
      ? 'broad_repo_walk_used; pass path_prefix to narrow scope for faster grep'
      : null,
    matches: allMatches,
  }
}

export function sourceRead(session, args, env = process.env) {
  const workspacePath = normalizeWorkspacePath(args.path, session)
  const parsed = parseWorkspacePath(workspacePath, session)
  assertReadablePath(parsed.workspacePath)

  const stat = fs.statSync(parsed.absolutePath)
  if (!stat.isFile()) throw new Error('not_a_file')
  if (stat.size > MAX_READ_BYTES) throw new Error(`file_too_large:${stat.size}`)

  const content = fs.readFileSync(parsed.absolutePath, 'utf8')
  const offset = Math.max(1, Number(args.offset || 1))
  const limit = Math.min(500, Math.max(1, Number(args.limit || 200)))
  const lines = content.split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)

  return {
    path: parsed.workspacePath,
    scope_id: parsed.entry.scopeId,
    total_lines: lines.length,
    offset,
    limit,
    content: slice.join('\n'),
  }
}

function listDrawableFiles(repoRoot, relPrefix) {
  const key = `${repoRoot.replace(/\\/g, '/').toLowerCase()}|${relPrefix || ''}`
  const now = Date.now()
  const hit = DRAWABLE_CACHE.get(key)
  if (hit && now - hit.at < DRAWABLE_CACHE_MS) return hit.files

  const files = walkFiles(repoRoot, relPrefix, 20000).filter((f) => DRAWABLE_FILE_RE.test(f.replace(/\\/g, '/')))
  DRAWABLE_CACHE.set(key, { files, at: now })
  return files
}

function drawableBaseName(filePath) {
  return path.basename(filePath).replace(/\.(webp|png|jpe?g|gif)$/i, '').toLowerCase()
}

export function fetchDrawable(session, args, env = process.env) {
  const projectId = String(args.project_id || 'demo-project').trim()
  const resourceName = String(args.resource_name || '').trim().toLowerCase()
  const namePrefix = String(args.name_prefix || '').trim().toLowerCase()
  const limit = Math.min(40, Math.max(1, Number(args.limit || 20)))

  if (!resourceName && !namePrefix) throw new Error('resource_name_or_name_prefix_required')

  const entries = entriesForProject(session, projectId)
  if (!entries.length) throw new Error('no_scope_for_project')

  const assets = []
  const seen = new Set()
  for (const entry of entries) {
    const repoRoot = resolveRepoRoot(entry, env)
    const relPrefix = entry.prefix || undefined
    const files = listDrawableFiles(repoRoot, relPrefix)
    for (const rel of files) {
      const base = drawableBaseName(rel)
      if (resourceName && base !== resourceName && !base.startsWith(`${resourceName}_`)) continue
      if (namePrefix && !base.startsWith(namePrefix) && !base.includes(namePrefix)) continue
      const workspacePath = `${entry.workspaceAlias}/${rel.replace(/\\/g, '/')}`
      if (seen.has(workspacePath)) continue
      seen.add(workspacePath)
      const ext = path.extname(rel).toLowerCase()
      assets.push({
        path: workspacePath,
        resource_name: base,
        mime: ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg',
        download_hint: `GET /assets?path=${encodeURIComponent(workspacePath)} with same Bearer token`,
      })
      if (assets.length >= limit) break
    }
    if (assets.length >= limit) break
  }

  return {
    project_id: projectId,
    resource_name: resourceName || null,
    name_prefix: namePrefix || null,
    count: assets.length,
    assets,
  }
}

export function readAsset(session, workspacePath, env = process.env) {
  const normalized = String(workspacePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!DRAWABLE_FILE_RE.test(normalized)) throw new Error('not_a_drawable_asset')
  const ext = path.extname(normalized).toLowerCase()
  if (!DRAWABLE_EXT.has(ext)) throw new Error('not_an_image')

  const parsed = parseWorkspacePath(normalized, session)
  const buf = fs.readFileSync(parsed.absolutePath)
  const mime =
    ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  return { buf, mime, filename: path.basename(normalized) }
}
