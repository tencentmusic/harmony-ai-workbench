#!/usr/bin/env node
/**
 * OpenCode SSE bridge：若已有同脚本 bridge 进程则先结束（避免重复监听 SSE）
 */
import { execSync, spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { resolveAndroidHarmonyKbRoot } from './lib/resolve-kb-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const kbRoot = resolveAndroidHarmonyKbRoot(repoRoot)
const bridgeScript = path.join(kbRoot, 'packages/kb-telemetry/adapters/opencode-sse-bridge.mjs')

const { killProcess } = await import(
  pathToFileURL(path.join(kbRoot, 'packages/kb-telemetry/lib/ensure-port.mjs')).href
)

function killDuplicateBridge() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ForEach-Object { \\"$($_.ProcessId)|$($_.CommandLine)\\" }"',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      )
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('opencode-sse-bridge.mjs')) continue
        const pid = Number(line.split('|')[0]?.trim())
        if (pid > 0 && pid !== process.pid) {
          console.log(`[ensure-port] 结束旧 telemetry bridge (pid=${pid})`)
          killProcess(pid)
        }
      }
      return
    }
    const out = execSync('pgrep -af opencode-sse-bridge.mjs', { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (pid > 0 && pid !== process.pid) {
        console.log(`[ensure-port] 结束旧 telemetry bridge (pid=${pid})`)
        killProcess(pid)
      }
    }
  } catch {
    // no duplicate
  }
}

killDuplicateBridge()

const env = {
  ...process.env,
  KB_TELEMETRY_ENABLED: process.env.KB_TELEMETRY_ENABLED || '1',
  KB_TELEMETRY_ENDPOINT:
    process.env.KB_TELEMETRY_ENDPOINT ||
    `http://127.0.0.1:${process.env.DEPLOY_PORT || process.env.WORKBENCH_PORT || process.env.PORT || '8082'}/api/kb-telemetry/v1/events`,
  KB_TELEMETRY_CONSUMER: 'opencode-bridge',
  OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4098',
}

console.log(`kb-telemetry bridge → ${env.OPENCODE_BASE_URL}/global/event`)

const child = spawn(process.execPath, [bridgeScript], { cwd: kbRoot, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
