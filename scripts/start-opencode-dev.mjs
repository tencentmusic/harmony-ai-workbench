#!/usr/bin/env node
/**
 * 启动 OpenCode harmony 实例（:4098），启动前清理同项目旧进程
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
loadWorkbenchEnv()
if (!process.env.CODEX_API_KEY?.trim()) {
  const fallback = process.env.SUB2API_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (fallback) process.env.CODEX_API_KEY = fallback
}
const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)
const opencodeScript =
  process.env.OPENCODE_START_SCRIPT || path.join(__dirname, 'start-opencode-harmony.mjs')
const port = Number(process.env.OPENCODE_PORT || 4098)

const { ensurePortAvailable, opencodeHarmonyService } = await import(
  pathToFileURL(path.join(kbRoot, 'packages/kb-telemetry/lib/ensure-port.mjs')).href
)

await ensurePortAvailable(port, opencodeHarmonyService, { label: 'opencode harmony' })

console.log(`opencode dev → http://127.0.0.1:${port}`)
console.log(`launcher     → ${opencodeScript}`)

const child = spawn(process.execPath, [opencodeScript], {
  cwd: path.dirname(opencodeScript),
  env: { ...process.env, OPENCODE_PORT: String(port) },
  stdio: 'inherit',
})

child.on('exit', (code) => process.exit(code ?? 1))
