import {
  buildJobPayload,
  createRepoSyncRun,
} from "./store";
import { dedupeTargetsByPath, matchManualTrigger, matchWebhookEvent } from "./matcher";
import { enqueueRepoSyncJob, hasRecentPendingJob } from "./queue";
import { parseGitLabWebhook } from "./gitlab-webhook";
import type { GitLabWebhookEvent } from "./types";

export type EnqueueRepoSyncInput =
  | { source: "gitlab"; body: Record<string, unknown> }
  | { source: "manual"; repo_id: string; branch?: string; trigger?: string };

export async function enqueueFromWebhookOrManual(input: EnqueueRepoSyncInput) {
  let event: GitLabWebhookEvent | null = null;
  let targets;

  if (input.source === "manual") {
    const one = matchManualTrigger(input);
    targets = one ? dedupeTargetsByPath([one]) : [];
  } else {
    event = parseGitLabWebhook(input.body);
    if (event.kind === "ignored") {
      return { accepted: false, reason: event.reason, event };
    }
    targets = dedupeTargetsByPath(matchWebhookEvent(event));
  }

  if (!targets.length) {
    return {
      accepted: false,
      reason: "no_matching_repo",
      event,
    };
  }

  const runs: Array<{ runId: string; repoIds: string[]; branch: string; debounced?: boolean }> = [];

  for (const t of targets) {
    if (hasRecentPendingJob(t.repoPath, t.branch)) {
      runs.push({ runId: "", repoIds: t.repoIds, branch: t.branch, debounced: true });
      continue;
    }
    const runId = await createRepoSyncRun({
      repoIds: t.repoIds,
      repoPath: t.repoPath,
      branch: t.branch,
      trigger: t.trigger,
      commitSha: t.commitSha,
    });
    enqueueRepoSyncJob(
      buildJobPayload(runId, {
        repoIds: t.repoIds,
        repoPath: t.repoPath,
        branch: t.branch,
        trigger: t.trigger,
        commitSha: t.commitSha,
        codegraphProjects: t.codegraphProjects,
      }),
    );
    runs.push({ runId, repoIds: t.repoIds, branch: t.branch });
  }

  return { accepted: true, event, runs };
}

export function authorizeRepoSyncWebhook(req: Request): boolean {
  const secret = String(process.env.REPO_SYNC_WEBHOOK_SECRET || "").trim();
  if (!secret) return false;
  const headers = ["x-repo-sync-secret", "x-gitlab-token"];
  return headers.some((h) => req.headers.get(h) === secret);
}
