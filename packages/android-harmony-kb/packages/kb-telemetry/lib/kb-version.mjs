import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_KB_ROOT = path.resolve(__dirname, '../../..')

let cached = null

function readLatestFreezeManifest(kbRoot) {
  const releaseDir = path.join(kbRoot, 'reports', 'release')
  if (!fs.existsSync(releaseDir)) return null
  const files = fs
    .readdirSync(releaseDir)
    .filter((f) => f.startsWith('freeze-manifest-') && f.endsWith('.json'))
    .sort()
  if (!files.length) return null
  const latest = files[files.length - 1]
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseDir, latest), 'utf8'))
  } catch {
    return null
  }
}

function hashManifest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest?.file_hashes || {})).digest('hex').slice(0, 16)
}

export function resolveKbVersionMeta(kbRoot = DEFAULT_KB_ROOT) {
  if (cached && cached.kbRoot === kbRoot) return cached.meta
  const manifest = readLatestFreezeManifest(kbRoot)
  const meta = {
    project_id: manifest?.project_id || 'demo-project',
    kb_version: manifest?.knowledge_version || 'unknown',
    kb_root_hash: manifest ? hashManifest(manifest) : 'unknown',
  }
  cached = { kbRoot, meta }
  return meta
}

export function resetKbVersionCache() {
  cached = null
}
