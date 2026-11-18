#!/usr/bin/env node
/**
 * 合并 opencode.global.json + agents/harmony/instance.json（含 android-harmony-kb-mcp）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'
import { listWorkspaceLinks, loadWorkspaceConfig } from '@kugou/workspace-config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return false
  const text = readFileSync(filePath, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let val = trimmed.slice(idx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
  return true
}

export function loadWorkbenchEnv() {
  for (const file of [
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.production'),
  ]) {
    if (loadEnvFile(file)) return file
  }
  return ''
}

function expandEnvString(value) {
  return String(value || '').replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '')
}

function toExternalAllowPattern(dir) {
  const normalized = String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return null
  return `${normalized}/**`
}

function resolveMcpSection(mcp) {
  if (!mcp || typeof mcp !== 'object') return undefined
  const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)
  const port = process.env.DEPLOY_PORT || process.env.WORKBENCH_PORT || process.env.PORT || '3100'
  const base = process.env.WORKBENCH_PUBLIC_URL || `http://127.0.0.1:${port}`
  const telemetryEndpoint =
    process.env.KB_TELEMETRY_ENDPOINT ||
    `${String(base).replace(/\/+$/, '')}/api/kb-telemetry/v1/events`
  const out = {}
  for (const [name, def] of Object.entries(mcp)) {
    const command = Array.isArray(def.command)
      ? def.command.map((part) => expandEnvString(part))
      : def.command
    if (Array.isArray(command) && command[0] === 'node' && command[1]) {
      command[1] = /harmony-kb-mcp\.mjs$/i.test(command[1]) || String(command[1]).includes('${WORKSPACE_KB_ROOT}')
        ? path.join(kbRoot, 'scripts/mcp/harmony-kb-mcp.mjs').replace(/\\/g, '/')
        : expandEnvString(command[1])
    }
    const legacyEnv = def.environment || def.env || {}
    const environment = {}
    for (const [k, v] of Object.entries(legacyEnv)) {
      if (k === 'KB_TELEMETRY_ENDPOINT' && String(v).includes('${KB_TELEMETRY_ENDPOINT}')) {
        environment[k] = telemetryEndpoint
      } else {
        environment[k] = expandEnvString(String(v))
      }
    }
    out[name] = {
      type: def.type === 'stdio' ? 'local' : def.type || 'local',
      enabled: def.enabled !== false,
      command,
      ...(def.cwd ? { cwd: expandEnvString(def.cwd) } : {}),
      environment: {
        ...environment,
        KB_TELEMETRY_ENABLED: process.env.KB_TELEMETRY_ENABLED || legacyEnv.KB_TELEMETRY_ENABLED || '1',
        KB_TELEMETRY_ENDPOINT: telemetryEndpoint,
        KB_TELEMETRY_CONSUMER: legacyEnv.KB_TELEMETRY_CONSUMER || 'opencode-mcp',
      },
    }
  }
  return out
}

export function renderOpencodeConfig(options = {}) {
  loadWorkbenchEnv()

  const globalPath = path.join(repoRoot, 'runtime', 'opencode', 'opencode.global.json')
  const instancePath = path.join(repoRoot, 'runtime', 'agents', 'harmony', 'instance.json')
  const cfg = JSON.parse(readFileSync(globalPath, 'utf8'))
  const instance = JSON.parse(readFileSync(instancePath, 'utf8'))

  const external = { ...(cfg.permission?.external_directory || {}), '*': 'deny' }
  const workspace = loadWorkspaceConfig({ repoRoot })
  const roots = listWorkspaceLinks(workspace).map((link) => link.root)
  for (const root of roots) {
    const pattern = toExternalAllowPattern(root)
    if (pattern) external[pattern] = 'allow'
  }

  cfg.permission = {
    ...(cfg.permission || {}),
    ...(instance.permissionExtras || {}),
    external_directory: external,
  }

  const mcp = resolveMcpSection(instance.mcp)
  if (mcp) cfg.mcp = mcp

  return cfg
}

export function writeOpencodeConfig(targetPath, options = {}) {
  const cfg = renderOpencodeConfig(options)
  mkdirSync(path.dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  return cfg
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target =
    process.argv[2] ||
    path.join(repoRoot, '.runtime', 'opencode-config', 'opencode.json')
  const cfg = writeOpencodeConfig(target)
  console.log(`opencode config → ${target}`)
  if (cfg.mcp) {
    for (const name of Object.keys(cfg.mcp)) {
      console.log(`  mcp: ${name}`)
    }
  }
}
