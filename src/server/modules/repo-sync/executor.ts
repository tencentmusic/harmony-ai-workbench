import { getDeployOnChange, getPreserveLocalFiles } from "./config";
import { runClassIndexForRepos } from "./class-index-runner";
import { runCodegraphSyncForProjects } from "./codegraph-runner";
import { pullChanged, runRedeploySync } from "./deploy-runner";
import { hardResetPull, readGitRev } from "./git-pull";
import { notifyRepoSyncResult } from "./notify";
import { acquirePathLock, savePendingSelfDeploy } from "./queue";
import { markRepoSyncFailed, markRepoSyncRunning, markRepoSyncSuccess } from "./store";
import type { RepoSyncJobPayload, RepoSyncRunResult } from "./types";

export async function executeRepoSyncJob(job: RepoSyncJobPayload): Promise<void> {
  const release = acquirePathLock(job.repoPath, job.runId);
  const result: RepoSyncRunResult = {};

  try {
    await markRepoSyncRunning(job.runId);

    const before = await readGitRev(job.repoPath);
    result.pull = { before: before || undefined };

    try {
      const pulled = await hardResetPull(job.repoPath, job.branch, {
        preserveLocalFiles: getPreserveLocalFiles(job.repoIds),
      });
      result.pull = {
        before: pulled.before || undefined,
        after: pulled.after,
        preserved: pulled.preserved,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not_git_repo")) {
        result.pull = { skipped: true, reason: msg, before: before || undefined };
      } else {
        throw e;
      }
    }

    const changed = pullChanged(result.pull);
    result.indexing = await runClassIndexForRepos(job.repoIds, changed);

    if (job.codegraphProjects.length) {
      result.codegraph = await runCodegraphSyncForProjects(job.codegraphProjects);
    } else {
      result.codegraph = { skipped: true, reason: "no_codegraph_projects" };
    }

    const deployCfg = getDeployOnChange(job.repoIds);
    if (deployCfg && !changed) {
      result.deploy = { skipped: true, reason: "no_code_change" };
    } else if (deployCfg && deployCfg.detached) {
      savePendingSelfDeploy({
        repoPath: job.repoPath,
        repoId: job.repoIds[0] || "repo",
        runId: job.runId,
        deploy: deployCfg,
      });
      result.deploy = { detached: true, reason: "queued_until_idle" };
    } else if (deployCfg) {
      result.deploy = runRedeploySync({ repoPath: job.repoPath, deploy: deployCfg });
    }

    await markRepoSyncSuccess(job.runId, result);
    await notifyRepoSyncResult({
      status: "success",
      repoIds: job.repoIds,
      branch: job.branch,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markRepoSyncFailed(job.runId, msg, result);
    await notifyRepoSyncResult({
      status: "failed",
      repoIds: job.repoIds,
      branch: job.branch,
      error: msg,
    });
    throw e;
  } finally {
    release();
  }
}
