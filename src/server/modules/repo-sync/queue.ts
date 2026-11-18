import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDebounceMs, getLockDir, getQueueDir, getQueueMetaDir, jobRestartsWorker } from "./config";
import type { RepoSyncDeployOnChange, RepoSyncJobPayload } from "./types";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function pathLockKey(repoPath: string): string {
  return crypto.createHash("sha1").update(repoPath).digest("hex");
}

export function isPathLocked(repoPath: string): boolean {
  const lockFile = path.join(getLockDir(), `${pathLockKey(repoPath)}.lock`);
  if (!fs.existsSync(lockFile)) return false;
  try {
    const lines = fs.readFileSync(lockFile, "utf8").trim().split("\n");
    const ts = Number(lines[1]);
    if (Number.isFinite(ts) && Date.now() - ts > 2 * 60 * 60 * 1000) {
      fs.unlinkSync(lockFile);
      return false;
    }
  } catch {
    /* keep lock if unreadable */
  }
  return true;
}

/** 清除超时 path lock（worker 异常退出遗留） */
export function clearStalePathLocks(maxAgeMs = 2 * 60 * 60 * 1000): number {
  const lockDir = getLockDir();
  if (!fs.existsSync(lockDir)) return 0;
  let cleared = 0;
  const now = Date.now();
  for (const file of fs.readdirSync(lockDir)) {
    if (!file.endsWith(".lock")) continue;
    const full = path.join(lockDir, file);
    try {
      const lines = fs.readFileSync(full, "utf8").trim().split("\n");
      const ts = Number(lines[1]);
      if (!Number.isFinite(ts) || now - ts >= maxAgeMs) {
        fs.unlinkSync(full);
        cleared++;
      }
    } catch {
      try {
        fs.unlinkSync(full);
        cleared++;
      } catch {
        /* ignore */
      }
    }
  }
  return cleared;
}

export function acquirePathLock(repoPath: string, runId: string): () => void {
  ensureDir(getLockDir());
  const lockFile = path.join(getLockDir(), `${pathLockKey(repoPath)}.lock`);
  fs.writeFileSync(lockFile, `${runId}\n${Date.now()}\n`, "utf8");
  return () => {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  };
}

/** debounce：同 path+branch 在窗口内已有 pending 任务则跳过新建 */
export function hasRecentPendingJob(repoPath: string, branch: string): boolean {
  const queueDir = getQueueDir();
  if (!fs.existsSync(queueDir)) return false;
  const now = Date.now();
  const debounceMs = getDebounceMs();
  const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(queueDir, file), "utf8")) as RepoSyncJobPayload;
      if (payload.repoPath === repoPath && payload.branch === branch) {
        const ts = Date.parse(payload.enqueuedAt || "");
        if (Number.isFinite(ts) && now - ts < debounceMs) return true;
      }
    } catch {
      /* ignore bad file */
    }
  }
  return false;
}

export function enqueueRepoSyncJob(payload: RepoSyncJobPayload): string {
  ensureDir(getQueueDir());
  const file = path.join(getQueueDir(), `${payload.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

export function listQueuedJobs(): RepoSyncJobPayload[] {
  const queueDir = getQueueDir();
  if (!fs.existsSync(queueDir)) return [];
  return fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(queueDir, f), "utf8")) as RepoSyncJobPayload;
      } catch {
        return null;
      }
    })
    .filter((x): x is RepoSyncJobPayload => !!x)
    .sort((a, b) => Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt));
}

export function dequeueJob(runId: string): RepoSyncJobPayload | null {
  const file = path.join(getQueueDir(), `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, "utf8")) as RepoSyncJobPayload;
  fs.unlinkSync(file);
  return payload;
}

/** 执行结束后再删队列文件；crash 时文件仍在，新 worker 可重试 */
export function completeJob(runId: string): void {
  const file = path.join(getQueueDir(), `${runId}.json`);
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function sortQueuedJobs(jobs: RepoSyncJobPayload[]): RepoSyncJobPayload[] {
  return [...jobs].sort((a, b) => {
    const ra = jobRestartsWorker(a.repoIds) ? 1 : 0;
    const rb = jobRestartsWorker(b.repoIds) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt);
  });
}

export type PendingSelfDeploy = {
  repoPath: string;
  repoId: string;
  runId: string;
  deploy: RepoSyncDeployOnChange;
};

function pendingSelfDeployFile(): string {
  return path.join(getQueueMetaDir(), "pending-self-deploy.json");
}

export function savePendingSelfDeploy(payload: PendingSelfDeploy): void {
  ensureDir(getQueueMetaDir());
  fs.writeFileSync(pendingSelfDeployFile(), JSON.stringify(payload, null, 2), "utf8");
}

export function loadPendingSelfDeploy(): PendingSelfDeploy | null {
  const file = pendingSelfDeployFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PendingSelfDeploy;
  } catch {
    return null;
  }
}

export function clearPendingSelfDeploy(): void {
  try {
    fs.unlinkSync(pendingSelfDeployFile());
  } catch {
    /* ignore */
  }
}

export function queueDepth(): number {
  const queueDir = getQueueDir();
  if (!fs.existsSync(queueDir)) return 0;
  return fs.readdirSync(queueDir).filter((f) => f.endsWith(".json")).length;
}
