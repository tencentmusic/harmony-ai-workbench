import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { clearStalePathLocks, listQueuedJobs } from "./queue";

/** DB 为 queued/running，但队列文件已不存在或 worker 已中断 → 标记取消/失败 */
export async function reconcileRepoSyncState(options: { staleLockMs?: number; staleRunningMs?: number } = {}) {
  const staleLockMs = options.staleLockMs ?? 2 * 60 * 60 * 1000;
  const staleRunningMs = options.staleRunningMs ?? 2 * 60 * 60 * 1000;
  const clearedLocks = clearStalePathLocks(staleLockMs);

  const queuedJobIds = new Set(listQueuedJobs().map((j) => j.runId));
  const now = Date.now();

  const pending = await prisma.repoSyncRun.findMany({
    where: { status: { in: ["queued", "running"] } },
    select: { id: true, status: true, startedAt: true, createdAt: true },
  });

  let cancelled = 0;
  let recovered = 0;

  for (const row of pending) {
    if (row.status === "queued" && !queuedJobIds.has(row.id)) {
      await prisma.repoSyncRun.update({
        where: { id: row.id },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          errorMessage: "orphan_no_queue_file",
        },
      });
      cancelled++;
      continue;
    }

    if (row.status === "running") {
      if (queuedJobIds.has(row.id)) {
        await prisma.repoSyncRun.update({
          where: { id: row.id },
          data: {
            status: "queued",
            startedAt: null,
            errorMessage: "requeued_after_worker_restart",
          },
        });
        recovered++;
        continue;
      }
      const started = row.startedAt?.getTime() ?? row.createdAt.getTime();
      if (now - started > staleRunningMs) {
        await prisma.repoSyncRun.update({
          where: { id: row.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            errorMessage: "worker_interrupted_or_stale_running",
          },
        });
        recovered++;
      }
    }
  }

  return { clearedLocks, cancelled, recovered, queueDepth: queuedJobIds.size };
}
