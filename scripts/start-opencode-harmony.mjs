#!/usr/bin/env node
/**
 * 本仓库内启动 OpenCode harmony（127.0.0.1:4098）。
 * dev:stack / opencode:dev 默认使用此脚本，不依赖 D:/soft/opencode 内硬编码工台路径。
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'
import { prepareOpencodeWorkspace } from './prepare-opencode-workspace.mjs'
import { writeOpencodeConfig } from './render-opencode-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

loadWorkbenchEnv()
resolveAndroidHarmonyKbRoot(repoRoot)

const host = process.env.OPENCODE_HOST || '127.0.0.1'
const port = Number(process.env.OPENCODE_PORT || 4098)
const workspace = path.resolve(
  process.env.OPENCODE_AGENT_CWD ||
    process.env.OPENCODE_WORKSPACE_DIR ||
    path.join(repoRoot, '.runtime', 'harmony-opencode-workspace'),
)

function resolveOpencodeBin() {
  const home = String(process.env.OPENCODE_HOME || 'D:/soft/opencode').trim()
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(home, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(home, 'node_modules', 'opencode-ai', 'bin', 'opencode'),
    'opencode',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'opencode') return c
    if (existsSync(c)) return c
  }
  throw new Error(
    [
      '找不到 opencode 可执行文件。',
      '请安装 OpenCode CLI 或设置 OPENCODE_BIN / OPENCODE_HOME（默认 D:/soft/opencode）。',
      `已尝试: ${candidates.join(', ')}`,
    ].join(' '),
  )
}

const opencodeBin = resolveOpencodeBin()
const opencodeConfigDir = path.join(repoRoot, '.runtime', 'opencode-config')
const opencodeCfg = writeOpencodeConfig(path.join(opencodeConfigDir, 'opencode.json'))

prepareOpencodeWorkspace({ workspaceDir: workspace })

const codexKey = process.env.CODEX_API_KEY?.trim() || process.env.SUB2API_API_KEY?.trim()
if (!codexKey) {
  console.error(
    'ERROR: 未设置 CODEX_API_KEY（或 SUB2API_API_KEY）。请在 kugou-harmony-ai-workbench 的 .env / .env.local 中配置。',
  )
  process.exit(1)
}
if (!process.env.CODEX_API_KEY?.trim()) {
  process.env.CODEX_API_KEY = codexKey
}

const serverPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim() || ''
if (!serverPassword) {
  console.error('ERROR: OPENCODE_SERVER_PASSWORD 未设置（见 .env.example，64 位 hex）')
  process.exit(1)
}
if (!/^[0-9a-fA-F]{64}$/.test(serverPassword)) {
  console.error('ERROR: OPENCODE_SERVER_PASSWORD 须为 64 位十六进制字符')
  process.exit(1)
}
process.env.OPENCODE_SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode'
process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir

console.log(`opencode-harmony config: ${path.join(opencodeConfigDir, 'opencode.json')}`)
if (opencodeCfg.mcp) {
  for (const name of Object.keys(opencodeCfg.mcp)) {
    console.log(`  mcp enabled: ${name}`)
  }
}

const telemetryManagedExternally =
  process.env.KB_TELEMETRY_MANAGED_BY === 'dev-stack' || process.env.SKIP_KB_TELEMETRY_SPAWN === '1'
if (telemetryManagedExternally) {
  console.log('kb-telemetry ingest/bridge 由 dev:stack 管理，跳过重复拉起')
}

console.log(`opencode-harmony starting → http://${host}:${port}`)
console.log(`opencode-harmony cwd: ${workspace}`)
console.log(`opencode-harmony binary: ${opencodeBin}`)

const serveArgs = ['serve', '--hostname', host, '--port', String(port)]
const usePathBin = opencodeBin !== 'opencode'
const child = spawn(usePathBin ? opencodeBin : 'opencode', serveArgs, {
  cwd: workspace,
  env: process.env,
  stdio: 'inherit',
  shell: !usePathBin,
})

child.on('exit', (code) => process.exit(code ?? 1))
