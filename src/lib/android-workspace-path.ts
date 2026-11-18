import {
  decodeScopedRelativePath,
  DEFAULT_WORKSPACE_ALIAS,
  getAndroidAppScopeById,
  getAndroidAppScopePrefixes,
  getHarmonyAppScopePrefixes,
  getHarmonyWorkspaceAliasForScope,
  scopeHasHarmonySource,
  type AndroidAppScope,
} from "@/lib/android-app-scopes";
import { decodeHarmonyScopedRelativePath } from "@/lib/harmony-scoped-path";

export function getWorkspaceAliasForScope(scope: AndroidAppScope | null) {
  if (!scope) return DEFAULT_WORKSPACE_ALIAS;
  return scope.workspaceAlias || DEFAULT_WORKSPACE_ALIAS;
}

/** 将索引 relative_path 转为 Agent workspace 内可读路径。 */
export function toAndroidWorkspacePath(relativePath: string, scopeIdHint?: string) {
  const rel = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.startsWith(`${DEFAULT_WORKSPACE_ALIAS}/`)) return rel;

  const harmonyDecoded = decodeHarmonyScopedRelativePath(rel);
  if (harmonyDecoded?.scopeId) {
    const scope = getAndroidAppScopeById(harmonyDecoded.scopeId);
    const alias = getHarmonyWorkspaceAliasForScope(scope);
    return `${alias}/${harmonyDecoded.repoRelativePath}`;
  }

  const decoded = decodeScopedRelativePath(rel);
  if (decoded.scopeId) {
    const scope = getAndroidAppScopeById(decoded.scopeId);
    const alias = getWorkspaceAliasForScope(scope);
    return `${alias}/${decoded.repoRelativePath}`;
  }

  if (scopeIdHint) {
    const scope = getAndroidAppScopeById(scopeIdHint);
    if (scope?.externalRepo) {
      const alias = getWorkspaceAliasForScope(scope);
      return `${alias}/${rel}`;
    }
  }

  return rel.startsWith(`${DEFAULT_WORKSPACE_ALIAS}/`) ? rel : `${DEFAULT_WORKSPACE_ALIAS}/${rel}`;
}

export function formatScopeSearchRoot(prefix: string, scope: AndroidAppScope | null) {
  const alias = getWorkspaceAliasForScope(scope);
  const normalized = prefix.replace(/\/$/, "");
  if (scope?.externalRepo && (scope.matchAll || normalized === ".")) {
    return `${alias}/（独立仓库全量检索）`;
  }
  return `${alias}/${normalized}/`;
}

export function formatHarmonyScopeSearchRoot(prefix: string, scope: AndroidAppScope | null) {
  const alias = getHarmonyWorkspaceAliasForScope(scope);
  const normalized = prefix.replace(/\/$/, "");
  if (scope?.harmonyMatchAll || normalized === ".") {
    return `${alias}/（鸿蒙仓库全量检索）`;
  }
  return `${alias}/${normalized}/`;
}

/** 「全部应用」模式下按各 scope 正确 alias 列出 Android 检索根 */
export function formatAllModeAndroidSearchRoots(scopeIds: string[]) {
  const groups: string[] = [];
  let totalPrefixes = 0;
  for (const scopeId of scopeIds) {
    const scope = getAndroidAppScopeById(scopeId);
    if (!scope) continue;
    const prefixes = getAndroidAppScopePrefixes(scopeId);
    if (!prefixes.length) continue;
    totalPrefixes += prefixes.length;
    if (scope.matchAll) {
      groups.push(`${scope.label}：${getWorkspaceAliasForScope(scope)}/（独立仓库全量）`);
      continue;
    }
    const samples = prefixes.slice(0, 4).map((p) => formatScopeSearchRoot(p, scope));
    groups.push(`${scope.label}：${samples.join("、")}${prefixes.length > 4 ? "…" : ""}`);
  }
  if (!groups.length) return `${DEFAULT_WORKSPACE_ALIAS}/（未限定前缀时全仓库检索）`;
  if (totalPrefixes <= 15) return groups.join("；");
  return `${groups.slice(0, 4).join("；")}…（多 App 前缀见 app-scopes.json）`;
}

/** 「全部应用」模式下按各 scope 正确 alias 列出 Harmony 检索根 */
export function formatAllModeHarmonySearchRoots(scopeIds: string[]) {
  const groups: string[] = [];
  for (const scopeId of scopeIds) {
    const scope = getAndroidAppScopeById(scopeId);
    if (!scope || !scopeHasHarmonySource(scope)) continue;
    const prefixes = getHarmonyAppScopePrefixes(scopeId);
    if (!prefixes.length) continue;
    const samples = prefixes.slice(0, 4).map((p) => formatHarmonyScopeSearchRoot(p, scope));
    groups.push(`${scope.label}：${samples.join("、")}${prefixes.length > 4 ? "…" : ""}`);
  }
  return groups.join("；");
}
