import { planClassIndexSlices } from "@/lib/class-index-slices";
import { listConfiguredRepos } from "@/server/modules/repo-sync/public";
import { reconcileRepoSyncState } from "@/server/modules/repo-sync/public";
import { listRepoSyncRuns } from "@/server/modules/repo-sync/public";
import { queueDepth } from "@/server/modules/repo-sync/public";
import type { RepoSyncConfigRepo } from "@/server/modules/repo-sync/public";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const limit = Number(new URL(req.url).searchParams.get("limit") || 50);
  const [runs, repos, reconcile] = await Promise.all([
    listRepoSyncRuns(limit),
    Promise.resolve(listConfiguredRepos()),
    reconcileRepoSyncState({ staleLockMs: 0, staleRunningMs: 5 * 60 * 1000 }),
  ]);
  return Response.json({
    queue_depth: queueDepth(),
    reconcile,
    repos: repos.map((r: RepoSyncConfigRepo) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      source_id: r.source_id,
      track_branches: r.track_branches,
      codegraph_projects: r.codegraph_projects,
      class_index: planClassIndexSlices(r).length > 0,
      deploy_on_change: r.deploy_on_change,
    })),
    runs,
  });
}
