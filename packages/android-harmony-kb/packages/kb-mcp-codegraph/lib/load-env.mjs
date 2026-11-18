import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const CODEGRAPH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const env = {}
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/g)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function applyEnvFile(filePath) {
  const parsed = parseEnvFile(filePath)
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return Object.keys(parsed).length
}

/** @returns {{ mode: string, loaded: string[] }} */
export function loadCodegraphEnv() {
  const mode = String(process.env.KB_MCP_ENV || process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase()
  const loaded = []

  if (applyEnvFile(path.join(CODEGRAPH_ROOT, '.env'))) loaded.push('.env')

  if (mode === 'production') {
    if (applyEnvFile(path.join(CODEGRAPH_ROOT, '.env.production'))) loaded.push('.env.production')
  } else if (applyEnvFile(path.join(CODEGRAPH_ROOT, '.env.local'))) {
    loaded.push('.env.local')
  }

  return { mode, loaded }
}

export const codegraphRoot = CODEGRAPH_ROOT
