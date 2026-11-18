import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./load-env-file.mjs";
import { prepareVideoTools } from "./prepare-video-tools.mjs";
import { resolvePrismaSqlitePath } from "./resolve-prisma-sqlite-path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, ".runtime", "deploy-preflight.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ checked_at: new Date().toISOString(), status: "running", npm_install: "running" }, null, 2) + "\n", { mode: 0o600 });
function recordStage(stage, status, error) {
  if (!fs.existsSync(reportPath)) return;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report[stage] = status;
  if (error) {
    report.status = "failed";
    report.error = error;
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
const install = spawnSync("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
  stdio: "inherit",
  cwd: root,
  shell: process.platform === "win32",
  env: process.env,
});
if (install.error) {
  recordStage("npm_install", "failed", install.error.message);
  console.error(install.error);
  process.exit(1);
}
if (install.status !== 0) {
  recordStage("npm_install", "failed", `npm ci exit ${install.status}`);
  process.exit(install.status ?? 1);
}
recordStage("npm_install", "passed");

const compressionRuntime = spawnSync(process.execPath, [path.join(__dirname, "prepare-image-compression.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (compressionRuntime.error || compressionRuntime.status !== 0) {
  recordStage("image_runtime", "failed", `image runtime exit ${compressionRuntime.status}`);
  console.error("[deploy] 图片压缩依赖准备失败，保留当前运行服务");
  process.exit(1);
}
recordStage("image_runtime", "passed");
const harnessRuntime = spawnSync(process.execPath, [path.join(__dirname, "prepare-harness-runtime.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (harnessRuntime.error || harnessRuntime.status !== 0) {
  console.error("[deploy] Harness 依赖检查失败，保留当前运行服务");
  process.exit(1);
}
const fileEnv = loadEnvFile(path.join(root, ".env.production"));
const runtimeEnv = { ...fileEnv, ...process.env };
try {
  Object.assign(runtimeEnv, prepareVideoTools(runtimeEnv));
} catch (error) {
  recordStage("video_runtime", "failed", error.message);
  console.error("[deploy] 视频解析依赖准备失败，保留当前运行服务", error);
  process.exit(1);
}
recordStage("video_runtime", "passed");
if (runtimeEnv.WORKSPACE_PROFILE === "test-server" && process.platform === "darwin") {
  runtimeEnv.DEVECO_HOME ||= "/Applications/DevEco-Studio.app/Contents";
  runtimeEnv.DEVECO_SDK_HOME ||= path.join(runtimeEnv.DEVECO_HOME, "sdk");
  runtimeEnv.JAVA_HOME ||= path.join(runtimeEnv.DEVECO_HOME, "jbr", "Contents", "Home");
}
const toolchainCheck = spawnSync(process.execPath, [path.join(__dirname, "check-cloud-agent-toolchain.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: runtimeEnv,
});
if (toolchainCheck.error || toolchainCheck.status !== 0) {
  recordStage("toolchain", "failed", `cloud Agent toolchain exit ${toolchainCheck.status}`);
  console.error("[deploy] 云 Agent 构建与 HDC 工具预检失败，保留当前运行服务");
  process.exit(1);
}
recordStage("toolchain", "passed");
const port = runtimeEnv.DEPLOY_PORT ?? runtimeEnv.PORT ?? "8082";
const databaseUrl = runtimeEnv.DEPLOY_DATABASE_URL ?? runtimeEnv.DATABASE_URL ?? "file:./data.prod.db";
const sqliteFile = resolvePrismaSqlitePath(databaseUrl, root);

const build = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  cwd: root,
  shell: process.platform === "win32",
  env: {
    ...runtimeEnv,
    NODE_ENV: "production",
  },
});
if (build.error) {
  recordStage("build", "failed", build.error.message);
  console.error(build.error);
  process.exit(1);
}
recordStage("build", build.status === 0 ? "passed" : "failed", build.status === 0 ? undefined : `next build exit ${build.status}`);
if (build.status !== 0) process.exit(build.status ?? 1);

const dbPush = spawnSync("npm", ["run", "db:push:prod"], {
  stdio: "inherit",
  cwd: root,
  shell: process.platform === "win32",
  env: {
    ...runtimeEnv,
    DATABASE_URL: databaseUrl,
  },
});
if (dbPush.error) {
  recordStage("database", "failed", dbPush.error.message);
  console.error(dbPush.error);
  process.exit(1);
}
recordStage("database", dbPush.status === 0 ? "passed" : "failed", dbPush.status === 0 ? undefined : `db:push:prod exit ${dbPush.status}`);
if (dbPush.status !== 0) process.exit(dbPush.status ?? 1);

const kill = spawnSync(process.execPath, [path.join(__dirname, "kill-port.mjs"), port], {
  stdio: "inherit",
  cwd: root,
});
if (kill.error) {
  recordStage("port_handoff", "failed", kill.error.message);
  console.error(kill.error);
  process.exit(1);
}
if (kill.status !== 0 && kill.status !== null) {
  recordStage("port_handoff", "failed", `kill-port exit ${kill.status}`);
  process.exit(kill.status);
}

const restart = spawnSync(process.execPath, [path.join(__dirname, "restart-service.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: runtimeEnv,
});
if (restart.error) {
  recordStage("restart", "failed", restart.error.message);
  console.error(restart.error);
  process.exit(1);
}
if (restart.status !== 0) {
  recordStage("restart", "failed", `restart-service exit ${restart.status}`);
  process.exit(restart.status ?? 1);
}
recordStage("restart", "passed");
const workerCheck = spawnSync(process.execPath, [path.join(__dirname, "verify-deployed-harness.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: runtimeEnv,
});
if (workerCheck.error || workerCheck.status !== 0) {
  console.error("[deploy] 云 Agent Worker 环境验收失败，请检查部署报告和 PM2 状态");
  process.exit(1);
}

if (process.platform !== "win32") {
  const opencode = spawnSync(
    "bash",
    [path.join(root, "runtime", "opencode", "deploy.sh")],
    {
      stdio: "inherit",
      cwd: root,
      env: runtimeEnv,
    },
  );
  if (opencode.error) {
    console.warn(`[deploy] OpenCode（含集成台 4110）部署失败（非致命）: ${opencode.error.message}`);
  } else if (opencode.status !== 0) {
    console.warn(`[deploy] OpenCode（含集成台 4110）部署退出码 ${opencode.status}（非致命）`);
  }
}

if (process.platform !== "win32") {
  const kbMcp = spawnSync(process.execPath, [path.join(__dirname, "deploy-kb-mcp-gateway.mjs")], {
    stdio: "inherit",
    cwd: root,
    env: runtimeEnv,
  });
  if (kbMcp.error) {
    console.warn(`[deploy] kb-mcp-for-zc 部署失败（非致命）: ${kbMcp.error.message}`);
  } else if (kbMcp.status !== 0) {
    console.warn(`[deploy] kb-mcp-for-zc 部署退出码 ${kbMcp.status}（非致命）`);
  }
}

if (process.platform !== "win32") {
  const cron = spawnSync("bash", [path.join(__dirname, "install-cron.sh")], {
    stdio: "inherit",
    cwd: root,
    env: runtimeEnv,
  });
  if (cron.error) {
    console.warn(`[deploy] install-cron 失败（非致命）: ${cron.error.message}`);
  } else if (cron.status !== 0) {
    console.warn(`[deploy] install-cron 退出码 ${cron.status}（非致命）`);
  }
}

console.log(
  `[deploy] PM2 已 reload harmony-workbench + harmony-workbench-repo-sync-worker PORT=${port}，生产库=${databaseUrl}（${sqliteFile}）。` +
    ` OpenCode：opencode-harmony:4098 + opencode-harmony-integration:4110。` +
    ` 查看: pm2 logs harmony-workbench / pm2 logs opencode-harmony-integration`,
);
