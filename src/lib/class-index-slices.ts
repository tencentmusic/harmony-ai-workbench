import { loadWorkspaceAppsConfig, type WorkspaceAppsConfig } from "@/lib/workspace-apps-config";

export type ClassIndexSlice =
  | { kind: "main_android"; pathPrefix?: string }
  | { kind: "android_scope"; scopeId: string }
  | { kind: "harmony_scope"; scopeId: string };

export type ClassIndexRepository = {
  id: string;
  source_id?: string;
  platform?: string;
  path_suffix?: string;
};

export function planClassIndexSlices(
  repo: ClassIndexRepository,
  config: WorkspaceAppsConfig = loadWorkspaceAppsConfig(),
): ClassIndexSlice[] {
  const sourceId = String(repo.source_id || repo.id || "").trim();
  if (!sourceId) return [];
  const suffix = String(repo.path_suffix || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const source = config.projects
    .flatMap((project) => [project.sources?.android, project.sources?.harmony])
    .find((candidate) => candidate?.source_id === sourceId);
  const slices: ClassIndexSlice[] = [];

  if (source?.index_mode === "main" && repo.platform !== "harmony") {
    slices.push(suffix ? { kind: "main_android", pathPrefix: suffix } : { kind: "main_android" });
  }
  for (const app of config.apps) {
    if (app.android?.source_id === sourceId && app.android.index_mode !== "main") {
      slices.push({ kind: "android_scope", scopeId: app.scope_id });
    }
    if (app.harmony?.source_id === sourceId) {
      slices.push({ kind: "harmony_scope", scopeId: app.scope_id });
    }
  }
  return mergeClassIndexSlices(slices);
}

export function planClassIndexSlicesForRepos(
  repos: ClassIndexRepository[],
  config?: WorkspaceAppsConfig,
): ClassIndexSlice[] {
  const resolved = config || loadWorkspaceAppsConfig();
  return mergeClassIndexSlices(repos.flatMap((repo) => planClassIndexSlices(repo, resolved)));
}

export function mergeClassIndexSlices(slices: ClassIndexSlice[]): ClassIndexSlice[] {
  const mains = slices.filter((slice) => slice.kind === "main_android");
  const out: ClassIndexSlice[] = [];
  if (mains.some((slice) => !slice.pathPrefix)) {
    out.push({ kind: "main_android" });
  } else {
    for (const pathPrefix of new Set(mains.map((slice) => slice.pathPrefix).filter((value): value is string => !!value))) {
      out.push({ kind: "main_android", pathPrefix });
    }
  }
  const seen = new Set<string>();
  for (const slice of slices) {
    if (slice.kind === "main_android") continue;
    const key = `${slice.kind}:${slice.scopeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slice);
  }
  return out;
}

export function describeClassIndexSlices(slices: ClassIndexSlice[]): string {
  return slices.map((slice) => {
    if (slice.kind === "main_android") return slice.pathPrefix ? `Android/${slice.pathPrefix}` : "Android 大仓";
    if (slice.kind === "android_scope") return `Android/${slice.scopeId}`;
    return `鸿蒙/${slice.scopeId}`;
  }).join("、");
}
