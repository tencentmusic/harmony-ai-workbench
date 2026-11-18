#!/usr/bin/env node
/**
 * 启动 Next.js 工台 dev（:3100），启动前清理同项目旧进程
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)
const port = Number(process.env.WORKBENCH_PORT || process.env.PORT || 3100)

const { ensurePortAvailable, workbenchNextService } = await import(
  pathToFileURL(path.join(kbRoot, 'packages/kb-telemetry/lib/ensure-port.mjs')).href
)

await ensurePortAvailable(port, workbenchNextService, { label: 'harmony workbench' })

console.log(`workbench dev → http://127.0.0.1:${port}`)

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'dev', '-p', String(port)], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('exit', (code) => process.exit(code ?? 1))
