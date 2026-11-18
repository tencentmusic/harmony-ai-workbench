import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoProjectRoot } from "./git-pull";
import type { RepoSyncDeployOnChange, RepoSyncDeployResult } from "./types";

export function pullChanged(pull?: { before?: string; after?: string; skipped?: boolean }): boolean {
  if (!pull || pull.skipped) return false;
  if (!pull.after) return false;
  return pull.before !== pull.after;
}

function commandLabel(command: string[]): string {
  return command.join(" ");
}

function shouldSkipCommand(command: string[]): string | null {
  const bin = command[0] || "";
  if (process.platform === "win32" && (bin === "bash" || bin.endsWith(".sh"))) {
    return "windows_skip_bash";
  }
  return null;
}

function spawnEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const extra = path.join(home, ".local", "node", "bin");
  const PATH = process.env.PATH || process.env.Path || "";
  return {
    ...process.env,
    PATH: PATH.includes(extra) ? PATH : `${extra}${path.delimiter}${PATH}`,
  };
}

export function runRedeploySync(input: {
  repoPath: string;
  deploy: RepoSyncDeployOnChange;
}): RepoSyncDeployResult {
  const cwd = resolveRepoProjectRoot(input.repoPath);
  const env = spawnEnv();
  const commands: NonNullable<RepoSyncDeployResult["commands"]> = [];

  for (const command of input.deploy.commands) {
    const skip = shouldSkipCommand(command);
    if (skip) {
      commands.push({ command: commandLabel(command), status: 0, skipped: true, reason: skip });
      continue;
    }
    const [bin, ...args] = command;
    const result = spawnSync(bin, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) {
      throw new Error(`deploy_failed:${commandLabel(command)}:${result.error.message}`);
    }
    const status = result.status ?? 1;
    commands.push({ command: commandLabel(command), status });
    if (status !== 0) {
      throw new Error(`deploy_failed:${commandLabel(command)}:exit_${status}`);
    }
  }

  if (commands.length && commands.every((c) => c.skipped)) {
    return { skipped: true, reason: "all_commands_skipped", cwd, commands };
  }
  return { cwd, commands };
}

export function startDetachedRedeploy(input: {
  repoPath: string;
  repoId: string;
  runId: string;
  deploy: RepoSyncDeployOnChange;
}): RepoSyncDeployResult {
  const cwd = resolveRepoProjectRoot(input.repoPath);
  const env = spawnEnv();
  const logDir = path.join(process.cwd(), "data", "repo-sync", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `redeploy-${input.repoId}-${input.runId}.log`);
  const fd = fs.openSync(logFile, "a");
  const header = `\n[${new Date().toISOString()}] runId=${input.runId} cwd=${cwd}\n`;
  fs.writeSync(fd, header);

  const command = input.deploy.commands[0];
  if (!command?.length) {
    fs.closeSync(fd);
    return { skipped: true, reason: "empty_command", cwd };
  }
  const skip = shouldSkipCommand(command);
  if (skip) {
    fs.closeSync(fd);
    return { skipped: true, reason: skip, cwd, log_file: logFile };
  }

  const [bin, ...args] = command;
  const child = spawn(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
    shell: process.platform === "win32",
  });
  child.unref();
  return {
    detached: true,
    pid: child.pid,
    cwd,
    log_file: logFile,
    commands: [{ command: commandLabel(command), status: null }],
  };
}
