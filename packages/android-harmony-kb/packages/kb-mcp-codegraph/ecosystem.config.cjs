// pm2 ecosystem for kb-mcp-for-codegraph（开放 HTTP MCP，仅 L2 CodeGraph）
//
// 启停：pm2 startOrReload <kb-root>/packages/kb-mcp-codegraph/ecosystem.config.cjs
// 日志：pm2 logs kb-mcp-for-codegraph

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CODEGRAPH_DIR = __dirname
const KB_ROOT = path.resolve(CODEGRAPH_DIR, '..', '..')
const HOME = os.homedir()
const LOG_DIR_BASE =
  process.env.LOG_DIR_BASE ||
  (process.platform === 'darwin'
    ? `${HOME}/Library/Logs`
    : `${HOME}/.local/log`)

function loadEnvFile(filePath) {
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

const codegraphEnv = {
  ...loadEnvFile(path.join(CODEGRAPH_DIR, '.env')),
  ...loadEnvFile(path.join(CODEGRAPH_DIR, '.env.production')),
}

const logDir = path.join(LOG_DIR_BASE, 'kb-mcp-for-codegraph')

module.exports = {
  apps: [
    {
      name: 'kb-mcp-for-codegraph',
      script: path.join(CODEGRAPH_DIR, 'scripts', 'run-codegraph.mjs'),
      args: '--production',
      cwd: KB_ROOT,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      kill_timeout: 5000,
      cron_restart: '0 4 * * *',
      out_file: path.join(logDir, 'out.log'),
      error_file: path.join(logDir, 'err.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        KB_MCP_ENV: 'production',
        ...codegraphEnv,
      },
    },
  ],
}
