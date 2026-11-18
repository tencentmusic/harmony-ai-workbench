import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { listCodegraphModules } from '../lib/codegraph-runtime.mjs'
import { loadAppCodeModules } from '../lib/app-code-modules.mjs'

const SERVER_ID = 'android-harmony-kb-mcp'
const LEGACY_SERVER_ID = 'harmony-kb-mcp'
const DEFAULT_TELEMETRY_ENDPOINT = 'http://127.0.0.1:3100/api/kb-telemetry/v1/events'

export function kbRootFromCli(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '../..')
}

export function mcpScriptPath(kbRoot) {
  return path.join(kbRoot, 'scripts/mcp/harmony-kb-mcp.mjs').replace(/\\/g, '/')
}

export function buildMcpServerEntry(kbRoot, options = {}) {
  const port = options.workbenchPort || process.env.WORKBENCH_PORT || process.env.PORT || '3100'
  const base = String(options.workbenchPublicUrl || process.env.WORKBENCH_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
  const telemetryEndpoint = options.telemetryEndpoint || process.env.KB_TELEMETRY_ENDPOINT || `${base}/api/kb-telemetry/v1/events`

  const env = {
    KB_TELEMETRY_ENABLED: options.telemetry ? '1' : '0',
  }
  if (options.telemetry) {
    env.KB_TELEMETRY_ENDPOINT = telemetryEndpoint
    env.KB_TELEMETRY_CONSUMER = options.telemetryConsumer || 'cursor-agent'
  }
  if (options.telemetryApiKey || process.env.KB_TELEMETRY_API_KEY) {
    env.KB_TELEMETRY_API_KEY = options.telemetryApiKey || process.env.KB_TELEMETRY_API_KEY
  }
  return {
    command: 'node',
    args: [mcpScriptPath(kbRoot)],
    env,
  }
}

/** L2 kb_codegraph_* 按 workspace 配置中的 project_id 检测索引。 */
export function auditCodegraphIndexes(projectIds = loadAppCodeModules().apps.map((app) => app.project_id)) {
  const byProject = {}
  let ready = false
  for (const projectId of projectIds) {
    const android = listCodegraphModules('android', projectId)
    const harmony = listCodegraphModules('harmonyos', projectId)
    byProject[projectId] = {
      android: { indexed: android.length, modules: android.map((m) => m.moduleRel) },
      harmony: { indexed: harmony.length, modules: harmony.map((m) => m.moduleRel) },
    }
    if (android.length > 0 || harmony.length > 0) ready = true
  }
  const firstProject = projectIds[0] || 'demo-project'
  const music = byProject[firstProject] || { android: { indexed: 0, modules: [] }, harmony: { indexed: 0, modules: [] } }
  return {
    android: music.android,
    harmony: music.harmony,
    projects: byProject,
    ready,
  }
}

export function detectAgents() {
  const home = os.homedir()
  const found = []
  if (fs.existsSync(path.join(home, '.cursor'))) found.push('cursor')
  if (fs.existsSync(path.join(home, '.codex'))) found.push('codex')
  if (fs.existsSync(path.join(home, '.claude.json')) || fs.existsSync(path.join(home, '.claude'))) {
    found.push('claude')
  }
  return found
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeJsonPretty(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function mergeCursorMcpConfig(targetFile, serverEntry) {
  const existing = readJsonSafe(targetFile)
  const next = { ...existing }
  const servers = { ...(existing.mcpServers || {}) }
  delete servers[LEGACY_SERVER_ID]
  servers[SERVER_ID] = serverEntry
  next.mcpServers = servers
  writeJsonPretty(targetFile, next)
  return targetFile
}

export function removeCursorMcpConfig(targetFile) {
  if (!fs.existsSync(targetFile)) return false
  const existing = readJsonSafe(targetFile)
  const servers = existing.mcpServers || {}
  let changed = false
  for (const id of [SERVER_ID, LEGACY_SERVER_ID]) {
    if (servers[id]) {
      delete servers[id]
      changed = true
    }
  }
  if (!changed) return false
  existing.mcpServers = servers
  writeJsonPretty(targetFile, existing)
  return true
}

export function workspaceRootForKb(kbRoot) {
  let current = path.resolve(kbRoot)
  while (true) {
    const packageFile = path.join(current, 'package.json')
    if (fs.existsSync(packageFile)) {
      const pkg = readJsonSafe(packageFile)
      if (pkg.name === 'kg-harmony-ai-workbench') return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.dirname(path.resolve(kbRoot))
}

/** Cursor 读取工作区根 .cursor/mcp.json；知识库是 workspace 包时定位到 Workbench 根目录。 */
export function resolveCursorMcpPaths(kbRoot, location = 'both') {
  const home = os.homedir()
  const paths = []
  if (location === 'project' || location === 'both') {
    paths.push(path.join(kbRoot, '.cursor/mcp.json'))
    const workspaceRoot = workspaceRootForKb(kbRoot)
    if (workspaceRoot !== home && workspaceRoot !== kbRoot) {
      paths.push(path.join(workspaceRoot, '.cursor/mcp.json'))
    }
  }
  if (location === 'global' || location === 'both') {
    paths.push(path.join(home, '.cursor/mcp.json'))
  }
  return [...new Set(paths)]
}

export function installCursor({ kbRoot, location = 'both', options = {} }) {
  const entry = buildMcpServerEntry(kbRoot, options)
  return resolveCursorMcpPaths(kbRoot, location).map((file) => mergeCursorMcpConfig(file, entry))
}

const CODEX_BLOCK_START = '# --- android-harmony-kb-mcp (managed by harmony-kb install) ---'
const CODEX_BLOCK_END = '# --- end android-harmony-kb-mcp ---'
const LEGACY_CODEX_BLOCK_START = '# --- harmony-kb-mcp (managed by harmony-kb install) ---'
const LEGACY_CODEX_BLOCK_END = '# --- end harmony-kb-mcp ---'

export function codexTomlBlock(kbRoot, options = {}) {
  const script = mcpScriptPath(kbRoot)
  const lines = [
    CODEX_BLOCK_START,
    '[mcp_servers.android-harmony-kb-mcp]',
    'command = "node"',
    `args = ["${script}"]`,
    '',
    '[mcp_servers.android-harmony-kb-mcp.env]',
    `KB_TELEMETRY_ENABLED = "${options.telemetry ? '1' : '0'}"`,
  ]
  if (options.telemetry) {
    lines.push(`KB_TELEMETRY_ENDPOINT = "${options.telemetryEndpoint || DEFAULT_TELEMETRY_ENDPOINT}"`)
    lines.push(`KB_TELEMETRY_CONSUMER = "${options.telemetryConsumer || 'codex-agent'}"`)
  }
  lines.push(CODEX_BLOCK_END)
  return lines.join('\n') + '\n'
}

function stripCodexManagedBlock(text) {
  for (const [start, end] of [
    [CODEX_BLOCK_START, CODEX_BLOCK_END],
    [LEGACY_CODEX_BLOCK_START, LEGACY_CODEX_BLOCK_END],
  ]) {
    const re = new RegExp(
      `\n?${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    )
    text = text.replace(re, '\n')
  }
  return text
}

export function installCodex({ kbRoot, options = {} }) {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  const block = codexTomlBlock(kbRoot, options)
  let text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  text = stripCodexManagedBlock(text)
  text = text.trimEnd() + (text.length ? '\n\n' : '') + block
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, text, 'utf8')
  return configPath
}

export function uninstallCodex() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  if (!fs.existsSync(configPath)) return false
  const before = fs.readFileSync(configPath, 'utf8')
  const after = stripCodexManagedBlock(before).trimEnd() + '\n'
  if (before === after) return false
  fs.writeFileSync(configPath, after, 'utf8')
  return true
}

export function installClaude({ kbRoot, options = {} }) {
  const configPath = path.join(os.homedir(), '.claude.json')
  const entry = buildMcpServerEntry(kbRoot, options)
  const existing = readJsonSafe(configPath)
  const servers = { ...(existing.mcpServers || {}) }
  delete servers[LEGACY_SERVER_ID]
  servers[SERVER_ID] = entry
  existing.mcpServers = servers
  writeJsonPretty(configPath, existing)
  return configPath
}

export function uninstallClaude() {
  const configPath = path.join(os.homedir(), '.claude.json')
  if (!fs.existsSync(configPath)) return false
  const existing = readJsonSafe(configPath)
  const servers = existing.mcpServers || {}
  let changed = false
  for (const id of [SERVER_ID, LEGACY_SERVER_ID]) {
    if (servers[id]) {
      delete servers[id]
      changed = true
    }
  }
  if (!changed) return false
  existing.mcpServers = servers
  writeJsonPretty(configPath, existing)
  return true
}

export function cursorMcpHasServer(targetFile) {
  const existing = readJsonSafe(targetFile)
  return Boolean(existing.mcpServers?.[SERVER_ID] || existing.mcpServers?.[LEGACY_SERVER_ID])
}

export function parseTargetArg(target, detected) {
  if (!target || target === 'auto') return detected.length ? detected : ['cursor']
  return target.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}
