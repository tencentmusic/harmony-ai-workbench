import { execFileSync } from "node:child_process";

const port = Number.parseInt(process.argv[2] ?? "3100", 10);
if (!Number.isFinite(port) || port <= 0) {
  console.error("Usage: node scripts/kill-port.mjs <port>");
  process.exit(2);
}

function listPidsWindows(portNumber) {
  try {
    const out = execFileSync("netstat", ["-ano"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const needle = `:${portNumber}`;
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const local = parts[1] ?? "";
      if (!local.endsWith(needle)) continue;
      const pid = Number.parseInt(parts[parts.length - 1], 10);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

function listPidsUnix(portNumber) {
  const bins = ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"];
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ["-nP", `-iTCP:${portNumber}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!out) continue;
      return out
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      continue;
    }
  }
  return [];
}

function listPids(portNumber) {
  return process.platform === "win32" ? listPidsWindows(portNumber) : listPidsUnix(portNumber);
}

function killAll(pids, signal) {
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        const args = ["/PID", String(pid)];
        if (signal === "SIGKILL") args.push("/F");
        execFileSync("taskkill", args, { stdio: "ignore" });
      } else {
        process.kill(pid, signal);
      }
    } catch {
      // ignore
    }
  }
}

const pids = listPids(port);
if (pids.length === 0) process.exit(0);

console.log(`[kill-port] port ${port} in use by pid(s): ${pids.join(", ")}`);
killAll(pids, "SIGTERM");
await new Promise((r) => setTimeout(r, 800));

const remaining = listPids(port);
if (remaining.length === 0) process.exit(0);

console.log(`[kill-port] still listening, SIGKILL pid(s): ${remaining.join(", ")}`);
killAll(remaining, "SIGKILL");
