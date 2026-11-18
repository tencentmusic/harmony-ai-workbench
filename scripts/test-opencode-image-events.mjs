#!/usr/bin/env node
/**
 * Smoke tests for OpenCode image helpers (inline copy for zero build deps).
 * Run: node scripts/test-opencode-image-events.mjs
 */

import assert from 'node:assert/strict'

const OPENCODE_ASSET_PREFIX = 'opencode-asset:'
const OPENCODE_ASSET_ROOTS = ['android-src/', 'migration-cases/']
const OPENCODE_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif']
const OPENCODE_IMAGE_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/gif'])

function normalizeSlashes(raw) {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isOpencodeImageMime(mime) {
  const value = String(mime || '').trim().toLowerCase()
  return !!value && OPENCODE_IMAGE_MIMES.has(value)
}

function normalizeOpencodeAssetPath(rawPath) {
  const path = normalizeSlashes(String(rawPath || '').trim())
  if (!path || path.includes('..') || path.startsWith('/')) return null
  if (!OPENCODE_ASSET_ROOTS.some((root) => path.startsWith(root))) return null
  const lower = path.toLowerCase()
  if (!OPENCODE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return null
  return path
}

function resolveOpencodeImageFromPart(part) {
  if (part.type !== 'file' || !isOpencodeImageMime(part.mime)) return null
  const fromSource = part.source?.type === 'file' ? normalizeOpencodeAssetPath(part.source.path) : null
  if (fromSource) return { path: fromSource, mime: part.mime }
  const url = String(part.url || '')
  if (url.startsWith(OPENCODE_ASSET_PREFIX)) {
    const path = normalizeOpencodeAssetPath(url.slice(OPENCODE_ASSET_PREFIX.length))
    if (path) return { path, mime: part.mime }
  }
  const fromFilename = normalizeOpencodeAssetPath(part.filename)
  if (fromFilename) return { path: fromFilename, mime: part.mime }
  return null
}

function imageEventFromPart(part, seen) {
  const image = resolveOpencodeImageFromPart(part)
  if (!image || seen.has(image.path)) return null
  seen.add(image.path)
  return { type: 'image', ...image }
}

assert.equal(normalizeOpencodeAssetPath('android-src/res/ic.webp'), 'android-src/res/ic.webp')
assert.equal(
  normalizeOpencodeAssetPath('migration-cases/KugouPlayer/ktv/drawable/icon.webp'),
  'migration-cases/KugouPlayer/ktv/drawable/icon.webp',
)
assert.equal(normalizeOpencodeAssetPath('../secret.png'), null)

const part = resolveOpencodeImageFromPart({
  type: 'file',
  mime: 'image/png',
  url: 'opencode-asset:android-src/res/icon.png',
  source: { type: 'file', path: 'android-src/res/icon.png' },
})
assert.ok(part)

const seen = new Set()
const evt = imageEventFromPart(
  {
    type: 'file',
    mime: 'image/webp',
    url: 'opencode-asset:android-src/res/a.webp',
  },
  seen,
)
assert.equal(evt.type, 'image')
assert.equal(imageEventFromPart({ type: 'file', mime: 'image/webp', url: 'opencode-asset:android-src/res/a.webp' }, seen), null)

const text = '路径：android-src/library/youngcommon/src/main/res/drawable/young_publish_ic_close.webp'
assert.ok(text.match(/android-src\/[^\s]+\.webp/i))

console.log('test-opencode-image-events: ok')
