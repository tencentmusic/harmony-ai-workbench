import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireKnowledgeBaseRoot } from "../../platform/knowledge-base-root";

export async function runCodegraphSyncForProjects(
  projects: string[],
): Promise<unknown> {
  if (!projects.length) {
    return { skipped: true, reason: "no_projects" };
  }
  const kbRoot = requireKnowledgeBaseRoot();
  const script = path.join(kbRoot, "scripts", "cli", "codegraph-sync.mjs");
  const mod = (await import(pathToFileURL(script).href)) as {
    runCodegraphSync: (root: string, opts: Record<string, unknown>) => Promise<unknown>;
  };
  return mod.runCodegraphSync(kbRoot, {
    projects,
    onlyStale: true,
  });
}
