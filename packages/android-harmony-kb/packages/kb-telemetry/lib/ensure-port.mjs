import { execSync } from 'node:child_process'

/**
 * 启动前端口占用处理：若为本项目相关进程则 kill，否则报错退出。
 */
export const kbTelemetryService = {
  name: 'kb-telemetry',
  cmdPatterns: [
    /opencode-sse-bridge\.mjs/i,
  ],
  async verifyByHealth(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return false
      const data = await res.json()
      return data?.service === 'kb-telemetry'
    } catch {
      return false
    }
  },
}

export const workbenchNextService = {
  name: 'workbench-next',
  cmdPatterns: [
    /next dev/i,
    /next\.js/i,
    /next[/\\]dist[/\\]bin/i,
    /start-server\.js/i,
    /kugou-harmony-ai-workbench/i,
    /kg-harmony-ai-workbench/i,
    /start-dev\.mjs/i,
    /start-dev-stack\.mjs/i,
    /harmony-ai-workbench/i,
  ],
  pathPatterns: [/tme-kugou/i, /kugou-harmony-ai-workbench/i, /kg-harmony-ai-workbench/i, /fx-skills-lab/i],
  async verifyByHealth(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
      return res.status >= 200 && res.status < 500
    } catch {
      return false
    }
  },
}

export const opencodeHarmonyService = {
  name: 'opencode-harmony',
  cmdPatterns: [/opencode/i, /start-harmony/i, /harmony-opencode/i],
  async verifyByHealth(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        return res.status >= 200 && res.status < 500
      } catch {
        return false
      }
    }
  },
}

function findListeningPids(port) {
  const pids = new Set()
  if (process.platform === 'win32') {
    try {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i')
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(re)
        if (m) pids.add(Number(m[1]))
      }
    } catch {
      // no listeners
    }
    return [...pids].filter((pid) => pid > 0)
  }

  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' })
    return out
      .split(/\r?\n/)
      .map((x) => Number(x.trim()))
      .filter((pid) => pid > 0)
  } catch {
    return []
  }
}

function getProcessCommandLine(pid) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      )
      return out.trim()
    } catch {
      try {
        return execSync(`wmic process where processid=${pid} get commandline /value`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim()
      } catch {
        return ''
      }
    }
  }
  try {
    return execSync(`ps -p ${pid} -o args=`, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
    return
  }
  process.kill(pid, 'SIGTERM')
  try {
    execSync(`kill -0 ${pid}`, { stdio: 'ignore' })
    execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

function matchesCmdPatterns(cmdline, patterns) {
  if (!cmdline) return false
  return patterns.some((re) => re.test(cmdline))
}

function matchesPathPatterns(cmdline, patterns = []) {
  if (!cmdline || !patterns.length) return false
  return patterns.some((re) => re.test(cmdline))
}

async function isOwnProcess(pid, port, service) {
  const cmdline = getProcessCommandLine(pid)

  if (typeof service.verifyByHealth === 'function') {
    const ok = await service.verifyByHealth(port)
    if (ok) return true
  }

  if (matchesCmdPatterns(cmdline, service.cmdPatterns)) return true

  if (matchesPathPatterns(cmdline, service.pathPatterns) && /\bnode(?:\.exe)?\b/i.test(cmdline)) {
    return true
  }

  return false
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {number} port
 * @param {{ name: string, cmdPatterns: RegExp[], verifyByHealth?: (port:number)=>Promise<boolean> }} service
 * @param {{ label?: string }} options
 */
export async function ensurePortAvailable(port, service, options = {}) {
  const label = options.label || service.name || `port:${port}`
  const pids = findListeningPids(port)
  if (!pids.length) return { port, action: 'free' }

  for (const pid of pids) {
    const own = await isOwnProcess(pid, port, service)
    const cmdline = getProcessCommandLine(pid)
    if (own) {
      console.log(`[ensure-port] ${label} :${port} 被旧进程占用 (pid=${pid})，正在结束…`)
      if (cmdline) console.log(`[ensure-port]   ${cmdline.slice(0, 200)}`)
      killProcess(pid)
      await sleep(400)
      continue
    }

    console.error(`[ensure-port] ${label} :${port} 被其他程序占用 (pid=${pid})，未自动结束。`)
    if (cmdline) console.error(`[ensure-port]   ${cmdline}`)
    console.error(`[ensure-port] 请手动释放端口 ${port} 后重试。`)
    process.exit(1)
  }

  const remaining = findListeningPids(port)
  if (remaining.length) {
    console.error(`[ensure-port] ${label} :${port} 释放后仍被占用 (pid=${remaining.join(', ')})`)
    process.exit(1)
  }

  return { port, action: 'cleared', clearedPids: pids }
}

export { findListeningPids, getProcessCommandLine, killProcess }
