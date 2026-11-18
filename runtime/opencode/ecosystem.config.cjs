// pm2 ecosystem for harmony opencode instance(s).
//
// 扫描 runtime/agents/*/instance.json，渲染 .runtime/start.<name>.sh 并登记 pm2 app。
//
// 启停：pm2 reload <repo>/runtime/opencode/ecosystem.config.cjs
// 日志：pm2 logs opencode-harmony

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT_DIR = __dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const AGENTS_DIR = path.join(REPO_ROOT, 'runtime', 'agents')
const RUNTIME_DIR = path.join(SCRIPT_DIR, '.runtime')
const TEMPLATE_PATH = path.join(SCRIPT_DIR, 'start.template.sh')
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

const prodEnv = loadEnvFile(path.join(REPO_ROOT, '.env.production'))

if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })

const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')

const renderStart = (instance) => {
  const integrationRuntime = instance.integrationRuntime === true
  const replacements = {
    NAME: instance.name,
    CWD: instance.cwd.replace(/\$\{HOME\}/g, HOME).replace(/\\/g, '/'),
    REPO_ROOT: REPO_ROOT.replace(/\\/g, '/'),
    HOST: instance.host || '127.0.0.1',
    PORT: String(instance.port),
    CONFIG_DIR: path.join(
      REPO_ROOT,
      '.runtime',
      integrationRuntime ? 'opencode-integration-xdg' : 'opencode-xdg',
      'opencode',
    ).replace(/\\/g, '/'),
    XDG_CONFIG_HOME: path.join(
      REPO_ROOT,
      '.runtime',
      integrationRuntime ? 'opencode-integration-xdg' : 'opencode-xdg',
    ).replace(/\\/g, '/'),
    INTEGRATION_RUNTIME: String(integrationRuntime),
  }
  let body = template
  for (const [key, val] of Object.entries(replacements)) {
    body = body.replaceAll(`\${${key}}`, val)
  }
  const outPath = path.join(RUNTIME_DIR, `start.${instance.name}.sh`)
  fs.writeFileSync(outPath, body, { mode: 0o755 })
  return outPath
}

const allInstances = fs
  .readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => {
    const cfgPath = path.join(AGENTS_DIR, d.name, 'instance.json')
    if (!fs.existsSync(cfgPath)) return null
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    if (cfg.name !== d.name) {
      throw new Error(
        `instance.json name mismatch: directory=${d.name} but name=${cfg.name}`,
      )
    }
    return cfg
  })
  .filter(Boolean)

const instanceMode = process.env.OPENCODE_INSTANCE_MODE || 'all'
const instances = allInstances.filter((instance) =>
  instanceMode === 'integration' ? instance.integrationRuntime === true : true)

const portSeen = new Map()
for (const i of instances) {
  if ((i.host || '127.0.0.1') !== '127.0.0.1') {
    throw new Error(`instance ${i.name} must bind 127.0.0.1`)
  }
  if (portSeen.has(i.port)) {
    throw new Error(
      `port ${i.port} used by both ${portSeen.get(i.port)} and ${i.name}`,
    )
  }
  portSeen.set(i.port, i.name)
}

const workbenchPort = prodEnv.DEPLOY_PORT || prodEnv.WORKBENCH_PORT || prodEnv.PORT || '8082'
const telemetryEndpoint =
  prodEnv.KB_TELEMETRY_ENDPOINT ||
  `http://127.0.0.1:${workbenchPort}/api/kb-telemetry/v1/events`

const apps = instances.map((instance) => {
  const startScript = renderStart(instance)
  const logDir = `${LOG_DIR_BASE}/opencode-${instance.name}`
  return {
    name: `opencode-${instance.name}`,
    script: startScript,
    interpreter: 'bash',
    cwd: SCRIPT_DIR,
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
    },
  }
})

const harmonyInstance = instances.find((instance) => instance.name === 'harmony')
if (harmonyInstance) {
  const bridgeLogDir = `${LOG_DIR_BASE}/kb-telemetry-bridge-harmony`
  const harmonyCwd = String(harmonyInstance.cwd || '').replace(/\$\{HOME\}/g, HOME)
  apps.push({
    name: 'kb-telemetry-bridge-harmony',
    script: path.join(REPO_ROOT, 'scripts/start-kb-telemetry-bridge.mjs'),
    cwd: REPO_ROOT,
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    kill_timeout: 5000,
    out_file: path.join(bridgeLogDir, 'out.log'),
    error_file: path.join(bridgeLogDir, 'err.log'),
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
      ...prodEnv,
      OPENCODE_BASE_URL: `http://${harmonyInstance.host || '127.0.0.1'}:${harmonyInstance.port}`,
      OPENCODE_WORKSPACE_DIRECTORY: harmonyCwd,
      OPENCODE_SERVER_USERNAME: prodEnv.OPENCODE_SERVER_USERNAME || 'opencode',
      OPENCODE_SERVER_PASSWORD: prodEnv.OPENCODE_SERVER_PASSWORD || '',
      KB_TELEMETRY_ENDPOINT: telemetryEndpoint,
      KB_TELEMETRY_CONSUMER: 'opencode-bridge',
    },
  })
}

module.exports = { apps }
