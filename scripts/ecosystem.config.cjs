// PM2：Harmony AI 工台 Next.js + 源码 sync worker + 云Agent worker
// 启停：npm run deploy / npm run service:restart
// 日志：pm2 logs harmony-workbench / pm2 logs harmony-workbench-repo-sync-worker

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT_DIR, ".runtime");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const prodEnv = loadEnvFile(path.join(ROOT_DIR, ".env.production"));
const port = prodEnv.DEPLOY_PORT || prodEnv.PORT || "8082";
const databaseUrl = prodEnv.DEPLOY_DATABASE_URL || prodEnv.DATABASE_URL || "file:./data.prod.db";
const sharedProdEnv = {
  NODE_ENV: "production",
  ...prodEnv,
  ...(process.env.CLOUD_AGENT_FFMPEG_BIN ? { CLOUD_AGENT_FFMPEG_BIN: process.env.CLOUD_AGENT_FFMPEG_BIN } : {}),
  ...(process.env.CLOUD_AGENT_FFPROBE_BIN ? { CLOUD_AGENT_FFPROBE_BIN: process.env.CLOUD_AGENT_FFPROBE_BIN } : {}),
};

module.exports = {
  apps: [
    {
      name: "harmony-cloud-agent-worker",
      cwd: ROOT_DIR,
      script: path.join(ROOT_DIR, "workers", "cloud-agent", "index.mjs"),
      interpreter: "node",
      interpreter_args: "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-ts.mjs --experimental-strip-types",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 120000,
      out_file: path.join(LOG_DIR, "harmony-cloud-agent-worker.log"),
      error_file: path.join(LOG_DIR, "harmony-cloud-agent-worker.err.log"),
      merge_logs: true,
      time: true,
      env: { ...sharedProdEnv, DATABASE_URL: databaseUrl },
    },
    {
      name: "harmony-workbench",
      cwd: ROOT_DIR,
      script: path.join(ROOT_DIR, "node_modules", "next", "dist", "bin", "next"),
      args: `start -p ${port}`,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,
      out_file: path.join(LOG_DIR, "workbench.log"),
      error_file: path.join(LOG_DIR, "workbench.err.log"),
      merge_logs: true,
      time: true,
      env: {
        ...sharedProdEnv,
        PORT: port,
        HOST: prodEnv.HOST || "0.0.0.0",
        HOSTNAME: prodEnv.HOSTNAME || prodEnv.HOST || "0.0.0.0",
        DATABASE_URL: databaseUrl,
      },
    },
    {
      name: "harmony-workbench-repo-sync-worker",
      cwd: ROOT_DIR,
      script: path.join(ROOT_DIR, "workers", "repo-sync", "index.mjs"),
      interpreter: "node",
      interpreter_args:
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-ts.mjs --experimental-strip-types",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 120000,
      out_file: path.join(LOG_DIR, "harmony-workbench-repo-sync-worker.log"),
      error_file: path.join(LOG_DIR, "harmony-workbench-repo-sync-worker.err.log"),
      merge_logs: true,
      time: true,
      env: {
        ...sharedProdEnv,
        DATABASE_URL: databaseUrl,
        REPO_SYNC_DEPLOYMENT_ID: prodEnv.REPO_SYNC_DEPLOYMENT_ID || "test-server",
      },
    },
  ],
};
