/**
 * PM2 启动或 reload harmony-workbench（跨平台，供 deploy 与 shell 脚本调用）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ecosystem = path.join(root, "scripts", "ecosystem.config.cjs");
const processName = "harmony-workbench";

function resolvePm2Bin() {
  const fromEnv = process.env.HARMONY_PM2_BIN?.trim();
  if (fromEnv) return fromEnv;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pm2"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const found = which.stdout?.trim().split(/\r?\n/)[0]?.trim();
  if (found) return found;
  if (process.platform === "win32") return "pm2.cmd";
  return "pm2";
}

function runPm2(args) {
  const pm2Bin = resolvePm2Bin();
  const result = spawnSync(pm2Bin, args, {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0 && result.status !== null) process.exit(result.status);
}

function pm2Describe(name) {
  const pm2Bin = resolvePm2Bin();
  const result = spawnSync(pm2Bin, ["describe", name], {
    encoding: "utf8",
    cwd: root,
    shell: process.platform === "win32",
    env: process.env,
  });
  return result.status === 0;
}

if (pm2Describe(processName)) {
  console.log(`[restart-service] pm2 已托管 ${processName}，执行 reload --update-env`);
  runPm2(["startOrReload", ecosystem, "--update-env"]);
  runPm2(["save"]);
} else {
  console.log(`[restart-service] pm2 中无 ${processName}，执行 start`);
  runPm2(["start", ecosystem]);
  runPm2(["save"]);
}

console.log(`[restart-service] 完成（harmony-workbench + harmony-workbench-repo-sync-worker + harmony-cloud-agent-worker）`);
