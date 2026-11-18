import { prisma } from "@/lib/prisma";
import { getDeploymentId } from "./config";
import type { RepoSyncJobPayload, RepoSyncRunResult } from "./types";

export async function createRepoSyncRun(input: {
  repoIds: string[];
  repoPath: string;
  branch: string;
  trigger: string;
  commitSha?: string;
}): Promise<string> {
  const row = await prisma.repoSyncRun.create({
    data: {
      repoId: input.repoIds.join(","),
      repoPath: input.repoPath,
      branch: input.branch,
      trigger: input.trigger,
      commitSha: input.commitSha || null,
      status: "queued",
      resultJson: "{}",
      deploymentId: getDeploymentId(),
    },
  });
  return row.id;
}

export async function markRepoSyncRunning(runId: string): Promise<void> {
  await prisma.repoSyncRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });
}

export async function markRepoSyncSuccess(runId: string, result: RepoSyncRunResult): Promise<void> {
  await prisma.repoSyncRun.update({
    where: { id: runId },
    data: {
      status: "success",
      finishedAt: new Date(),
      gitRevBefore: result.pull?.before || null,
      gitRevAfter: result.pull?.after || null,
      resultJson: JSON.stringify(result),
      errorMessage: null,
    },
  });
}

export async function markRepoSyncFailed(runId: string, error: string, partial?: RepoSyncRunResult): Promise<void> {
  await prisma.repoSyncRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      finishedAt: new Date(),
      gitRevBefore: partial?.pull?.before || null,
      gitRevAfter: partial?.pull?.after || null,
      resultJson: JSON.stringify(partial || {}),
      errorMessage: error.slice(0, 4000),
    },
  });
}

export async function listRepoSyncRuns(limit = 50) {
  const rows = await prisma.repoSyncRun.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    repo_id: r.repoId,
    repo_path: r.repoPath,
    branch: r.branch,
    trigger: r.trigger,
    commit_sha: r.commitSha,
    status: r.status,
    git_rev_before: r.gitRevBefore,
    git_rev_after: r.gitRevAfter,
    result: safeJson(r.resultJson),
    error_message: r.errorMessage,
    started_at: r.startedAt?.toISOString() || null,
    finished_at: r.finishedAt?.toISOString() || null,
    created_at: r.createdAt.toISOString(),
    deployment_id: r.deploymentId,
  }));
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function buildJobPayload(runId: string, input: Omit<RepoSyncJobPayload, "runId" | "enqueuedAt">): RepoSyncJobPayload {
  return {
    runId,
    ...input,
    enqueuedAt: new Date().toISOString(),
  };
}
