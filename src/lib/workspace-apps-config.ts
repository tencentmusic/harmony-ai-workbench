import path from "node:path";
import {
  findWorkspaceApp,
  findWorkspaceProject,
  listRepoSyncRepositories,
  listPortalKnowledgeBases,
  listWorkspaceLinks,
  listWorkspaceApps,
  loadWorkspaceConfig,
  resetWorkspaceConfigCache,
  resolveAppSource,
  resolveAppKnowledgeSource,
  resolveAppKnowledgeSources,
  resolveDocument,
  resolveKnowledgeBase,
  resolveProjectKnowledge,
  resolveProjectSource,
  toLegacyScopeRows,
  type LegacyAppScopeRow,
  type WorkspaceAppEntry,
  type WorkspaceAppsConfig,
  type WorkspaceProject,
} from "@kugou/workspace-config";

export type {
  LegacyAppScopeRow,
  WorkspaceAppEntry,
  WorkspaceAppsConfig,
  WorkspaceProject,
};

export const loadWorkspaceAppsConfig = loadWorkspaceConfig;
export {
  findWorkspaceApp,
  findWorkspaceProject,
  listRepoSyncRepositories,
  listPortalKnowledgeBases,
  listWorkspaceLinks,
  listWorkspaceApps,
  resetWorkspaceConfigCache,
  resolveAppSource,
  resolveAppKnowledgeSource,
  resolveAppKnowledgeSources,
  resolveDocument,
  resolveKnowledgeBase,
  resolveProjectKnowledge,
  resolveProjectSource,
  toLegacyScopeRows,
};

export function getWorkbenchRepoRoot() {
  return loadWorkspaceConfig().repo_root;
}

export function listPortalKnowledgeWorkspaceRoots(group: "technical" | "migration") {
  const config = loadWorkspaceConfig();
  return listPortalKnowledgeBases(group, config).map((source) => {
    const parts = [
      String(source.workspace_alias || source.id || "").trim(),
      String(source.query?.content_root || "").trim(),
      String(source.portal?.tree_root || "").trim(),
    ].map((item) => item.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
    return parts.join("/");
  }).filter(Boolean);
}

export function resolveSharedAndroidMonorepoPath(config: WorkspaceAppsConfig = loadWorkspaceConfig()) {
  return config.projects.find((project) => project.sources?.android?.index_mode === "main")
    ?.sources?.android?.resolved_path || "";
}

export function resolveSharedAndroidMonorepoIndexRoots(
  config: WorkspaceAppsConfig = loadWorkspaceConfig(),
) {
  const roots = config.projects.find((project) => project.sources?.android?.index_mode === "main")
    ?.sources?.android?.index_roots;
  if (!Array.isArray(roots)) return [];
  return [...new Set(
    roots
      .map((root) => String(root || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean),
  )];
}

export function resolveAppAndroidRepoPath(app: WorkspaceAppEntry, config: WorkspaceAppsConfig = loadWorkspaceConfig()) {
  return findWorkspaceApp(app.scope_id || app.app_id, config)?.android?.path || "";
}

export function resolveAppHarmonyRepoPath(app: WorkspaceAppEntry, config: WorkspaceAppsConfig = loadWorkspaceConfig()) {
  return findWorkspaceApp(app.scope_id || app.app_id, config)?.harmony?.path || "";
}

export function getSharedPathBinding(
  key: "android_monorepo" | "harmony" | "harmony_docs" | "knowledge_base",
  config: WorkspaceAppsConfig = loadWorkspaceConfig(),
) {
  if (key === "android_monorepo") {
    const source = config.projects.find((project) => project.sources?.android?.index_mode === "main")?.sources?.android;
    return source?.resolved_path ? { path: source.resolved_path } : undefined;
  }
  if (key === "harmony") {
    const source = config.projects.find((project) => project.sources?.harmony)?.sources?.harmony;
    return source?.resolved_path ? { path: source.resolved_path } : undefined;
  }
  if (key === "harmony_docs") {
    const source = listPortalKnowledgeBases("migration", config)[0];
    if (!source?.root) return undefined;
    const contentRoot = String(source.query?.content_root || "").trim();
    return { path: contentRoot ? path.resolve(source.root, contentRoot) : source.root };
  }
  const kb = resolveKnowledgeBase("android-harmony-kb", config);
  return kb?.root ? { path: kb.root } : undefined;
}
