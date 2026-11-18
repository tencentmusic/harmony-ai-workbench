import { startDetachedRedeploy } from "./deploy-runner";
import {
  clearPendingSelfDeploy,
  completeJob,
  isPathLocked,
  listQueuedJobs,
  loadPendingSelfDeploy,
  queueDepth,
  sortQueuedJobs,
} from "./queue";
import { executeRepoSyncJob } from "./executor";
import { reconcileRepoSyncState } from "./reconcile";
import type { RepoSyncJobPayload } from "./types";

export async function processNextRepoSyncJob(): Promise<{
  processed: boolean;
  runId?: string;
  error?: string;
}> {
  const jobs = sortQueuedJobs(listQueuedJobs());
  for (const job of jobs) {
    if (isPathLocked(job.repoPath)) continue;
    try {
      await executeRepoSyncJob(job);
      completeJob(job.runId);
      return { processed: true, runId: job.runId };
    } catch (e) {
      completeJob(job.runId);
      const msg = e instanceof Error ? e.message : String(e);
      return { processed: true, runId: job.runId, error: msg };
    }
  }
  return { processed: false };
}

/** 队列清空后再 reload worker，避免排队任务随进程被杀掉且队列文件已删 */
export function flushPendingSelfDeployIfIdle(): boolean {
  if (queueDepth() > 0) return false;
  const pending = loadPendingSelfDeploy();
  if (!pending) return false;
  clearPendingSelfDeploy();
  const started = startDetachedRedeploy(pending);
  console.log(
    `[harmony-workbench-repo-sync-worker] idle → detached deploy repo=${pending.repoId} pid=${started.pid || "-"} log=${started.log_file || "-"}`,
  );
  return true;
}

export async function runRepoSyncWorkerLoop(options: {
  intervalMs?: number;
  once?: boolean;
  onTick?: (info: { processed: boolean; runId?: string; error?: string }) => void;
} = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 5000;
  const boot = await reconcileRepoSyncState({ staleLockMs: 0, staleRunningMs: 5 * 60 * 1000 });
  if (boot.cancelled || boot.recovered || boot.clearedLocks) {
    console.log(
      `[harmony-workbench-repo-sync-worker] reconcile locks=${boot.clearedLocks} cancelled=${boot.cancelled} recovered=${boot.recovered}`,
    );
  }

  const tick = async () => {
    const info = await processNextRepoSyncJob();
    flushPendingSelfDeployIfIdle();
    options.onTick?.(info);
    if (info.processed) {
      console.log(`[harmony-workbench-repo-sync-worker] done runId=${info.runId}${info.error ? ` error=${info.error}` : ""}`);
    }
  };

  await tick();
  if (options.once) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await tick();
  }
}

export type { RepoSyncJobPayload };
