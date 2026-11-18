import { getRepoById, listConfiguredRepos } from "./config";
import { remoteMatches } from "./gitlab-webhook";
import type { GitLabWebhookEvent, RepoSyncConfigRepo } from "./types";

export type MatchedRepoSyncTarget = {
  repo: RepoSyncConfigRepo;
  repoPath: string;
  branch: string;
  commitSha?: string;
  trigger: string;
};

function branchAllowed(repo: RepoSyncConfigRepo, branch: string): boolean {
  const list = repo.track_branches || [];
  if (!list.length) return true;
  return list.includes(branch);
}

export function matchWebhookEvent(event: GitLabWebhookEvent): MatchedRepoSyncTarget[] {
  if (event.kind === "ignored") return [];
  const trigger = event.kind === "merge" ? "webhook:merge" : "webhook:push";
  const out: MatchedRepoSyncTarget[] = [];

  for (const row of listConfiguredRepos()) {
    if (!row.path) continue;
    if (!remoteMatches(row.remote_match, event.remoteKey)) continue;
    if (!branchAllowed(row, event.branch)) continue;
    out.push({
      repo: row,
      repoPath: row.path,
      branch: event.branch,
      commitSha: event.commitSha || undefined,
      trigger,
    });
  }
  return out;
}

export function matchManualTrigger(input: {
  repo_id: string;
  branch?: string;
  trigger?: string;
}): MatchedRepoSyncTarget | null {
  const row = getRepoById(input.repo_id);
  if (!row?.path) return null;
  const branch = input.branch || row.track_branches?.[0] || "master";
  return {
    repo: row,
    repoPath: row.path,
    branch,
    trigger: input.trigger || "manual",
  };
}

/** 同一路径（如测试服双鸿蒙 env 指向同一目录）合并为一条任务 */
export function dedupeTargetsByPath(targets: MatchedRepoSyncTarget[]): Array<{
  repoIds: string[];
  repoPath: string;
  branch: string;
  commitSha?: string;
  trigger: string;
  codegraphProjects: string[];
}> {
  const map = new Map<
    string,
    {
      repoIds: string[];
      repoPath: string;
      branch: string;
      commitSha?: string;
      trigger: string;
      codegraphProjects: Set<string>;
    }
  >();

  for (const t of targets) {
    const key = `${t.repoPath}::${t.branch}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        repoIds: [],
        repoPath: t.repoPath,
        branch: t.branch,
        commitSha: t.commitSha,
        trigger: t.trigger,
        codegraphProjects: new Set(),
      };
      map.set(key, bucket);
    }
    if (!bucket.repoIds.includes(t.repo.id)) bucket.repoIds.push(t.repo.id);
    for (const p of t.repo.codegraph_projects || []) bucket.codegraphProjects.add(p);
    if (t.commitSha) bucket.commitSha = t.commitSha;
  }

  return [...map.values()].map((b) => ({
    repoIds: b.repoIds,
    repoPath: b.repoPath,
    branch: b.branch,
    commitSha: b.commitSha,
    trigger: b.trigger,
    codegraphProjects: [...b.codegraphProjects],
  }));
}
