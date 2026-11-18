/**
 * 按 modulePath 缓存 CodeGraph.openSync() 实例，避免每次 L2 工具 spawn CLI 冷开 SQLite。
 * SDK 不可用时由 codegraph.mjs 回退到 CLI。
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/** @type {typeof import('@colbymchenry/codegraph').CodeGraph | null} */
let CodeGraphClass = null
let sdkLoadError = null

try {
  const pkg = require('@colbymchenry/codegraph')
  CodeGraphClass = pkg.CodeGraph || pkg.default?.CodeGraph || null
} catch (err) {
  sdkLoadError = err instanceof Error ? err.message : String(err)
}

const cache = new Map()
const MAX_OPEN = Number(process.env.KB_CODEGRAPH_CACHE_MAX || 24)

function normalizeProjectPath(projectPath) {
  return path.resolve(String(projectPath || '')).replace(/\\/g, '/').toLowerCase()
}

function hasIndex(projectPath) {
  try {
    return fs.existsSync(path.join(projectPath, '.codegraph', 'codegraph.db'))
  } catch {
    return fs.existsSync(path.join(projectPath, '.codegraph'))
  }
}

function evictOldest() {
  if (cache.size < MAX_OPEN) return
  let oldestKey = null
  let oldestAt = Infinity
  for (const [key, entry] of cache) {
    if (entry.lastUsedAt < oldestAt) {
      oldestAt = entry.lastUsedAt
      oldestKey = key
    }
  }
  if (!oldestKey) return
  const entry = cache.get(oldestKey)
  try {
    entry?.cg?.close?.()
  } catch {
    /* ignore */
  }
  cache.delete(oldestKey)
}

export function isCodegraphSdkEnabled() {
  return Boolean(CodeGraphClass?.openSync)
}

export function getCodegraphSdkLoadError() {
  return sdkLoadError
}

/** @returns {import('@colbymchenry/codegraph').CodeGraph | null} */
export function getCachedCodeGraph(projectPath) {
  if (!CodeGraphClass?.openSync) return null
  const abs = path.resolve(String(projectPath || ''))
  if (!hasIndex(abs)) return null

  const key = normalizeProjectPath(abs)
  const existing = cache.get(key)
  if (existing) {
    existing.lastUsedAt = Date.now()
    try {
      existing.cg.reopenIfReplaced?.()
    } catch {
      /* ignore */
    }
    return existing.cg
  }

  try {
    evictOldest()
    const cg = CodeGraphClass.openSync(abs)
    cache.set(key, { cg, openedAt: Date.now(), lastUsedAt: Date.now() })
    return cg
  } catch (err) {
    sdkLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

export function clearCodegraphCache() {
  for (const entry of cache.values()) {
    try {
      entry.cg?.close?.()
    } catch {
      /* ignore */
    }
  }
  cache.clear()
}

export function getCodegraphCacheStats() {
  return {
    enabled: isCodegraphSdkEnabled(),
    loadError: sdkLoadError,
    size: cache.size,
    max: MAX_OPEN,
    modules: [...cache.keys()],
  }
}
