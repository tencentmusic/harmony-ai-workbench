#!/usr/bin/env node
/**
 * 启动集成台专用 OpenCode（127.0.0.1:4110）。
 * 与聊天实例隔离：独立 cwd / XDG profile / Basic 鉴权，不挂载 android-src。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

loadWorkbenchEnv()
const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)

const host = '127.0.0.1'
const port = resolveIntegrationPort()
const workspace = resolveIntegrationWorkspace()
const integrationCfgSrc = path.join(
  repoRoot,
  'runtime',
  'opencode',
  'opencode.integration.json',
)
const xdgRoot = path.join(repoRoot, '.runtime', 'opencode-integration-xdg')
const configDir = path.join(xdgRoot, 'opencode')
const integrationHome = path.join(repoRoot, '.runtime', 'opencode-integration-home')

function resolveIntegrationPort() {
  const fromPort = Number(process.env.OPENCODE_INTEGRATION_PORT)
  if (Number.isFinite(fromPort) && fromPort > 0) return fromPort
  try {
    const parsed = new URL(process.env.OPENCODE_INTEGRATION_BASE_URL || 'http://127.0.0.1:4110')
    return Number(parsed.port || 4110)
  } catch {
    return 4110
  }
}

function resolveIntegrationWorkspace() {
  const fromEnv = process.env.OPENCODE_INTEGRATION_AGENT_CWD?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(repoRoot, '.runtime', 'harmony-integration-opencode-runtime')
}

function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function resolveOpencodeBin() {
  const home = String(process.env.OPENCODE_HOME || 'D:/soft/opencode').trim()
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(home, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(home, 'node_modules', 'opencode-ai', 'bin', 'opencode'),
    'opencode',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === 'opencode') return candidate
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    [
      '找不到 opencode 可执行文件。',
      '请安装 OpenCode CLI 或设置 OPENCODE_BIN / OPENCODE_HOME（默认 D:/soft/opencode）。',
      `已尝试: ${candidates.join(', ')}`,
    ].join(' '),
  )
}

function assertNotSharedWithChat() {
  const chatBase = process.env.OPENCODE_BASE_URL?.trim()
  const integrationBase = (
    process.env.OPENCODE_INTEGRATION_BASE_URL || `http://${host}:${port}`
  ).trim()
  if (!chatBase) return
  try {
    if (new URL(chatBase).origin === new URL(integrationBase).origin) {
      throw new Error(
        'OPENCODE_INTEGRATION_BASE_URL 不能与 OPENCODE_BASE_URL 相同；集成台必须使用独立 OpenCode（默认 :4110）。',
      )
    }
  } catch (error) {
    if (error instanceof TypeError) return
    throw error
  }
}

function prepareWorkspace() {
  mkdirSync(workspace, { recursive: true })
  if (isSymlink(workspace) || !lstatSync(workspace).isDirectory()) {
    throw new Error(`integration CWD 必须是非符号链接目录：${workspace}`)
  }
  const envLocal = path.join(workspace, '.env.local')
  if (existsSync(envLocal)) {
    renameSync(envLocal, `${envLocal}.quarantine.${Date.now()}`)
    console.warn(`opencode-harmony-integration quarantined ${envLocal}`)
  }
  const agentsSrc = path.join(repoRoot, 'runtime', 'agents', 'harmony-integration', 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    copyFileSync(agentsSrc, path.join(workspace, 'AGENTS.md'))
  }
  writeFileSync(
    path.join(workspace, 'opencode.json'),
    `${JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2)}\n`,
  )
}

function writeIntegrationProfile() {
  if (!existsSync(integrationCfgSrc) || isSymlink(integrationCfgSrc)) {
    throw new Error(`配置源必须是非符号链接普通文件：${integrationCfgSrc}`)
  }
  mkdirSync(path.dirname(xdgRoot), { recursive: true })
  if (isSymlink(xdgRoot) || isSymlink(configDir)) {
    throw new Error(`integration profile 路径不能是符号链接：${configDir}`)
  }
  if (existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true })
  }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'opencode.json'), readFileSync(integrationCfgSrc))
}

function buildChildEnv(username, password, sub2apiKey) {
  mkdirSync(integrationHome, { recursive: true })
  mkdirSync(path.join(repoRoot, '.runtime', 'opencode-integration-data'), { recursive: true })
  mkdirSync(path.join(repoRoot, '.runtime', 'opencode-integration-cache'), { recursive: true })
  mkdirSync(path.join(repoRoot, '.runtime', 'opencode-integration-state'), { recursive: true })

  const base =
    process.platform === 'win32'
      ? { ...process.env }
      : {
          PATH: process.env.PATH,
          LANG: process.env.LANG || 'C.UTF-8',
          TMPDIR: process.env.TMPDIR || os.tmpdir(),
        }

  const env = {
    ...base,
    HOME: integrationHome,
    ...(process.platform === 'win32' ? { USERPROFILE: integrationHome } : {}),
    XDG_CONFIG_HOME: xdgRoot,
    XDG_DATA_HOME: path.join(repoRoot, '.runtime', 'opencode-integration-data'),
    XDG_CACHE_HOME: path.join(repoRoot, '.runtime', 'opencode-integration-cache'),
    XDG_STATE_HOME: path.join(repoRoot, '.runtime', 'opencode-integration-state'),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    SUB2API_API_KEY: sub2apiKey,
    OPENAI_API_KEY: sub2apiKey,
    OPENCODE_PORT: String(port),
  }

  delete env.OPENCODE_AGENT_CWD
  delete env.OPENCODE_WORKSPACE_DIR
  delete env.OPENCODE_WORKSPACE_DIRECTORY
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_CONTENT
  delete env.OPENCODE_PERMISSION
  delete env.CODEX_API_KEY
  delete env.DEEPSEEK_API_KEY
  delete env.OPENCODE_START_SCRIPT
  return env
}

assertNotSharedWithChat()

const { ensurePortAvailable, opencodeHarmonyService } = await import(
  pathToFileURL(path.join(kbRoot, 'packages/kb-telemetry/lib/ensure-port.mjs')).href
)
await ensurePortAvailable(port, opencodeHarmonyService, { label: 'opencode harmony-integration' })

const serverPassword = process.env.OPENCODE_INTEGRATION_SERVER_PASSWORD?.trim() || ''
if (!serverPassword) {
  console.error('ERROR: OPENCODE_INTEGRATION_SERVER_PASSWORD 未设置（见 .env.example，64 位 hex）')
  process.exit(1)
}
if (!/^[0-9a-fA-F]{64}$/.test(serverPassword)) {
  console.error('ERROR: OPENCODE_INTEGRATION_SERVER_PASSWORD 须为 64 位十六进制字符')
  process.exit(1)
}

const serverUsername = process.env.OPENCODE_INTEGRATION_SERVER_USERNAME?.trim() || 'opencode'
if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverUsername)) {
  console.error('ERROR: OPENCODE_INTEGRATION_SERVER_USERNAME 非法')
  process.exit(1)
}

const sub2apiKey = process.env.SUB2API_API_KEY?.trim() || ''
if (!sub2apiKey) {
  console.error('ERROR: SUB2API_API_KEY 未设置（集成台固定模型需要）')
  process.exit(1)
}

prepareWorkspace()
writeIntegrationProfile()

const opencodeBin = resolveOpencodeBin()
const childEnv = buildChildEnv(serverUsername, serverPassword, sub2apiKey)

console.log(`opencode-harmony-integration config: ${path.join(configDir, 'opencode.json')}`)
console.log(`opencode-harmony-integration starting → http://${host}:${port}`)
console.log(`opencode-harmony-integration cwd: ${workspace}`)
console.log(`opencode-harmony-integration binary: ${opencodeBin}`)

const serveArgs = ['serve', '--hostname', host, '--port', String(port)]
const usePathBin = opencodeBin !== 'opencode'
const child = spawn(usePathBin ? opencodeBin : 'opencode', serveArgs, {
  cwd: workspace,
  env: childEnv,
  stdio: 'inherit',
  shell: !usePathBin,
})

child.on('exit', (code) => process.exit(code ?? 1))
