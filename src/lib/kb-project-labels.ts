import {
  findWorkspaceApp,
  findWorkspaceProject,
  loadWorkspaceAppsConfig,
} from "@/lib/workspace-apps-config";

function defaultKbProjectId() {
  const config = loadWorkspaceAppsConfig();
  return config.projects[0]?.kb_project_id || config.projects[0]?.project_id || "unknown";
}

export function labelKbProject(projectId: string) {
  const id = String(projectId || "").trim();
  const project = findWorkspaceProject(id);
  return project?.label || id || "未知应用";
}

export function resolveKbProjectIdFromAppScope(appScopeId?: string | null) {
  const sid = String(appScopeId || "").trim();
  return findWorkspaceApp(sid)?.kb_project_id || defaultKbProjectId();
}

export function listKbProjectIdsFromScopeIds(scopeIds: string[]) {
  const projects = new Set<string>();
  for (const sid of scopeIds) projects.add(resolveKbProjectIdFromAppScope(sid));
  return [...projects];
}

export function resolveKbProjectIdFromHarmonyFqn(fqn: string) {
  const match = /^harmony\.([A-Za-z0-9_]+)\./.exec(String(fqn || "").trim());
  return match ? findWorkspaceApp(match[1])?.kb_project_id || null : null;
}

export function resolveKbProjectIdForChat(opts: {
  appScopeId: string;
  allowedScopeIds: string[];
  classRefs?: Array<{ fqn?: string }>;
  message?: string;
}) {
  const sid = String(opts.appScopeId || "").trim();
  if (sid && sid !== "all") return resolveKbProjectIdFromAppScope(sid);

  for (const ref of opts.classRefs || []) {
    const fromFqn = resolveKbProjectIdFromHarmonyFqn(ref.fqn || "");
    if (fromFqn) return fromFqn;
  }

  const projects = listKbProjectIdsFromScopeIds(opts.allowedScopeIds || []);
  if (projects.length === 1) return projects[0];

  const message = String(opts.message || "");
  for (const app of loadWorkspaceAppsConfig().apps) {
    if (message.includes(app.label) || message.includes(app.scope_id)) return app.kb_project_id;
  }
  return defaultKbProjectId();
}

export function formatKbProjectScopeMapping(scopeIds: string[]) {
  return [...new Set(scopeIds.map((sid) => `${sid} → project_id=${resolveKbProjectIdFromAppScope(sid)}`))];
}

export function resolveAndroidWorkspaceAliasForKbProject(projectId: string) {
  return findWorkspaceProject(projectId)?.sources?.android?.workspace_alias || "android-src";
}

export function resolveHarmonyWorkspaceAliasForKbProject(projectId: string) {
  return findWorkspaceProject(projectId)?.sources?.harmony?.workspace_alias || "harmony-src";
}

export function kbProjectOptions(ids: string[]) {
  const unique = [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))].sort((a, b) =>
    labelKbProject(a).localeCompare(labelKbProject(b), "zh-CN"),
  );
  return unique.map((id) => ({ value: id, label: labelKbProject(id) }));
}
