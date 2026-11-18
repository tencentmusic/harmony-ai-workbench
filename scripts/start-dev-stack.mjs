#!/usr/bin/env node
/**
 * 一键启动本地开发栈（按序清端口 + 并行保活）：
 *   opencode:dev               :4098
 *   opencode:integration:dev   :4110
 *   telemetry:bridge           (SSE → OpenCode)
 *   dev                        :3100
 *   repo-sync:worker           (源码 Webhook 队列消费)
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'
import { createDevWebRestart } from './lib/dev-web-restart.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
loadWorkbenchEnv()

const lockId = createHash('sha256').update(repoRoot.toLowerCase()).digest('hex').slice(0, 12)
const lockPath = path.join(os.tmpdir(), `kugou-harmony-ai-workbench-dev-stack-${lockId}.pid`)
let ownsLock = false

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function releaseLock() {
  if (!ownsLock) return
  try {
    const owner = Number(fs.readFileSync(lockPath, 'utf8').trim())
    if (owner === process.pid) fs.unlinkSync(lockPath)
  } catch {
    // lock already removed
  }
  ownsLock = false
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
      ownsLock = true
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner = 0
      try { owner = Number(fs.readFileSync(lockPath, 'utf8').trim()) } catch { /* stale lock */ }
      if (processExists(owner)) throw new Error(`dev_stack_already_running:${owner}`)
      try { fs.unlinkSync(lockPath) } catch { /* retry will report */ }
    }
  }
  throw new Error('dev_stack_lock_failed')
}

acquireLock()
process.on('exit', releaseLock)

const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)

const portOpencode = Number(process.env.OPENCODE_PORT || 4098)
const portIntegration = resolveIntegrationPort()
const portDev = Number(process.env.WORKBENCH_PORT || process.env.PORT || 3100)

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

const {
  ensurePortAvailable,
  opencodeHarmonyService,
  workbenchNextService,
} = await import(pathToFileURL(path.join(kbRoot, 'packages/kb-telemetry/lib/ensure-port.mjs')).href)

const SERVICES = [
  { name: 'opencode', script: 'start-opencode-dev.mjs', port: portOpencode },
  { name: 'opencode-integration', script: 'start-opencode-integration.mjs', port: portIntegration },
  { name: 'bridge', script: 'start-kb-telemetry-bridge.mjs' },
  { name: 'dev', script: 'start-dev.mjs', port: portDev },
  {
    name: 'harmony-workbench-repo-sync-worker',
    entry: path.join(repoRoot, 'workers', 'repo-sync', 'index.mjs'),
    nodeArgs: [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import', pathToFileURL(path.join(repoRoot, 'scripts', 'register-ts.mjs')).href,
      '--experimental-strip-types',
    ],
  },
  {
    name: 'harmony-cloud-agent-worker',
    entry: path.join(repoRoot, 'workers', 'cloud-agent', 'index.mjs'),
    nodeArgs: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', pathToFileURL(path.join(repoRoot, 'scripts', 'register-ts.mjs')).href, '--experimental-strip-types'],
  },
]

const children = []
let shuttingDown = false
const webRestart = createDevWebRestart(launchService)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function prefixLines(label, chunk, isErr = false) {
  const text = chunk.toString()
  const sink = isErr ? process.stderr : process.stdout
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    sink.write(`[${label}] ${line}\n`)
  }
}

function launchService(service) {
  const childEnv = { ...process.env }
  if (service.name === 'opencode') {
    childEnv.KB_TELEMETRY_MANAGED_BY = 'dev-stack'
  }

  let cmd
  let args
  cmd = process.execPath
  args = service.entry
    ? [...(service.nodeArgs || []), service.entry]
    : [path.join(repoRoot, 'scripts', service.script)]

  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  child.stdout.on('data', (buf) => prefixLines(service.name, buf))
  child.stderr.on('data', (buf) => prefixLines(service.name, buf, true))
  let exited = false
  const onExit = (code, signal) => {
    if (exited) return
    exited = true
    if (shuttingDown) return
    if (webRestart.handleExit(service)) {
      const index = children.findIndex(item => item.child === child)
      if (index >= 0) children.splice(index, 1)
      return
    }
    shuttingDown = true
    console.error(`[dev:stack] ${service.name} 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})，正在停止其余服务…`)
    void shutdownAll(code ?? 1)
  }
  child.on('exit', onExit)
  child.on('error', error => { console.error(`[dev:stack] ${service.name} 启动失败：${error.message}`); onExit(1, null) })

  children.push({ name: service.name, child })
  console.log(`[dev:stack] 已启动 ${service.name}${service.port ? ` (:${service.port})` : ''}`)
  return child
}

async function waitForHttp(base, label, timeoutMs = 120_000) {
  const urls = [`${base.replace(/\/+$/, '')}/health`, `${base.replace(/\/+$/, '')}/`]
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'manual' })
        if (res.status >= 200 && res.status < 500) {
          console.log(`[dev:stack] ${label} 已就绪 → ${url}`)
          return true
        }
      } catch {
        // retry
      }
    }
    await sleep(1500)
  }
  console.error(`[dev:stack] 等待 ${label} 超时，仍尝试启动其余服务`)
  return false
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function terminateChild(name, child) {
  if (child.killed || child.exitCode != null || !child.pid) return
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      await new Promise((resolve) => killer.once('exit', resolve))
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
    await waitForChildExit(child, 5000)
    if (child.exitCode == null && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      await waitForChildExit(child, 2000)
    }
    console.log(`[dev:stack] 已停止 ${name}`)
  } catch {
    console.error(`[dev:stack] 停止 ${name} 失败，请检查 PID ${child.pid}`)
  }
}

async function shutdownAll(exitCode = 0) {
  webRestart.stop()
  if (shuttingDown && children.every(({ child }) => child.exitCode != null || child.killed)) return
  shuttingDown = true
  await Promise.all(children.map(({ name, child }) => terminateChild(name, child)))
  releaseLock()
  process.exit(exitCode)
}

process.on('SIGINT', () => {
  console.log('\n[dev:stack] 收到 Ctrl+C，正在停止全部服务…')
  void shutdownAll(0)
})
process.on('SIGTERM', () => void shutdownAll(0))

console.log('[dev:stack] 启动本地开发栈…')
console.log(`[dev:stack]   opencode:dev               → :${portOpencode}`)
console.log(`[dev:stack]   opencode:integration:dev   → :${portIntegration}`)
console.log('[dev:stack]   telemetry:bridge           → OpenCode SSE')
console.log(`[dev:stack]   dev                        → :${portDev}`)
console.log('[dev:stack]   harmony-workbench-repo-sync-worker → git pull + codegraph queue')
console.log('[dev:stack]   harmony-cloud-agent-worker → independent task analysis')
console.log('')

console.log('[dev:stack] 预清理端口…')
await ensurePortAvailable(portOpencode, opencodeHarmonyService, { label: 'opencode harmony' })
await ensurePortAvailable(portIntegration, opencodeHarmonyService, { label: 'opencode harmony-integration' })
await ensurePortAvailable(portDev, workbenchNextService, { label: 'harmony workbench' })
console.log('[dev:stack] 端口已就绪')
console.log('')

launchService(SERVICES[0])
launchService(SERVICES[1])

await Promise.all([
  waitForHttp(process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4098', 'OpenCode 聊天'),
  waitForHttp(
    process.env.OPENCODE_INTEGRATION_BASE_URL || `http://127.0.0.1:${portIntegration}`,
    'OpenCode 集成台',
  ),
])
launchService(SERVICES[2])
launchService(SERVICES[3])
launchService(SERVICES[4])
launchService(SERVICES[5])

console.log('')
console.log(`[dev:stack] 全部已拉起。工台 → http://127.0.0.1:${portDev}`)
console.log('[dev:stack] 按 Ctrl+C 停止全部服务')
