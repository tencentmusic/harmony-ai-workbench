import path from "node:path";
import {
  loadWorkspaceAppsConfig,
  toLegacyScopeRows,
  type LegacyAppScopeRow,
} from "@/lib/workspace-apps-config";

export const ALL_APP_SCOPE_ID = "all";
export const SCOPE_PATH_SEP = "::";
export const DEFAULT_WORKSPACE_ALIAS = "android-src";
export const DEFAULT_HARMONY_WORKSPACE_ALIAS = "harmony-src";

export type AndroidAppScope = {
  id: string;
  label: string;
  prefixes: string[];
  projectId?: string;
  kbProjectId?: string;
  repositoryId?: string;
  repoRoot?: string;
  externalRepo?: boolean;
  /** Agent workspace 内 symlink 目录名，默认 android-src（主仓）或 live-src 等 */
  workspaceAlias?: string;
  /** 相对仓库根的 git ls-files 扫描根；独立仓默认 ["."] */
  indexRoots?: string[];
  /** 为 true 时该 scope 覆盖独立仓库全部模块（prefixes 可省略） */
  matchAll?: boolean;
  harmonyRepositoryId?: string;
  harmonyRepoRoot?: string;
  /** Agent workspace 内鸿蒙 symlink 目录名，默认 harmony-src */
  harmonyWorkspaceAlias?: string;
  /** 鸿蒙仓库内允许检索的相对路径前缀 */
  harmonyPrefixes?: string[];
  /** 为 true 时鸿蒙侧允许全仓库检索（harmonyPrefixes 可省略） */
  harmonyMatchAll?: boolean;
};

let appScopesCacheKey = "";
let appScopesCache: AndroidAppScope[] = [];

function normalizePrefix(raw: string) {
  return raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeIndexRoots(raw: unknown, isExternal: boolean) {
  const roots = Array.isArray(raw)
    ? raw.map((x) => normalizePrefix(String(x || ""))).filter(Boolean)
    : [];
  if (roots.length) return [...new Set(roots)];
  return isExternal ? ["."] : [];
}

function truthyFlag(raw: unknown) {
  if (raw === true) return true;
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function normalizeScopeRow(row: LegacyAppScopeRow): AndroidAppScope | null {
  const id = String(row?.id || "").trim();
  const label = String(row?.label || id).trim();
  const repoRoot = String(row?.repoRoot || "").trim() || undefined;
  const workspaceAlias = String(row?.workspaceAlias || "").trim() || undefined;
  const matchAll = truthyFlag(row?.matchAll);
  const harmonyRepoRoot = String(row?.harmonyRepoRoot || "").trim() || undefined;
  const harmonyWorkspaceAlias =
    String(row?.harmonyWorkspaceAlias || "").trim() || DEFAULT_HARMONY_WORKSPACE_ALIAS;
  const harmonyMatchAll = truthyFlag(row?.harmonyMatchAll);
  const harmonyPrefixesRaw = Array.isArray(row?.harmonyPrefixes) ? row.harmonyPrefixes : [];
  const harmonyPrefixes = harmonyPrefixesRaw
    .map((x) => normalizePrefix(String(x || "")))
    .filter(Boolean);
  const prefixesRaw = Array.isArray(row?.prefixes) ? row.prefixes : [];
  const prefixes = prefixesRaw.map((x) => normalizePrefix(String(x || ""))).filter(Boolean);
  const isExternal = row?.externalRepo === true;
  if (!id || !label) return null;
  if (!isExternal && !prefixes.length) return null;
  if (isExternal && !prefixes.length && !matchAll) return null;
  if (harmonyRepoRoot && !harmonyPrefixes.length && !harmonyMatchAll) return null;
  const scope: AndroidAppScope = {
    id,
    label,
    projectId: String(row?.projectId || "").trim() || undefined,
    kbProjectId: String(row?.kbProjectId || "").trim() || undefined,
    prefixes: prefixes.length ? [...new Set(prefixes)] : matchAll ? ["."] : [],
    repositoryId: String(row?.repositoryId || "").trim() || undefined,
    repoRoot,
    externalRepo: isExternal,
    workspaceAlias: workspaceAlias || (isExternal ? `${id.toLowerCase()}-src` : DEFAULT_WORKSPACE_ALIAS),
    indexRoots: normalizeIndexRoots(row?.indexRoots, isExternal),
    matchAll: isExternal ? matchAll || prefixes.includes(".") : false,
    harmonyRepositoryId: String(row?.harmonyRepositoryId || "").trim() || undefined,
    harmonyRepoRoot,
    harmonyWorkspaceAlias: harmonyRepoRoot ? harmonyWorkspaceAlias : undefined,
    harmonyPrefixes:
      harmonyRepoRoot && harmonyPrefixes.length
        ? [...new Set(harmonyPrefixes)]
        : harmonyRepoRoot && harmonyMatchAll
          ? ["."]
          : undefined,
    harmonyMatchAll: harmonyRepoRoot ? harmonyMatchAll || harmonyPrefixes.includes(".") : false,
  };
  return scope;
}

function loadScopeRowsFromConfig(): LegacyAppScopeRow[] {
  const config = loadWorkspaceAppsConfig();
  return toLegacyScopeRows(config);
}

export function parseAndroidAppScopes(): AndroidAppScope[] {
  let cacheKey = "";
  try {
    const config = loadWorkspaceAppsConfig();
    cacheKey = `${config.schema_version || "1"}:${config.apps.length}`;
  } catch {
    return [];
  }
  if (cacheKey && cacheKey === appScopesCacheKey) return appScopesCache;
  try {
    const out: AndroidAppScope[] = [];
    for (const row of loadScopeRowsFromConfig()) {
      const scope = normalizeScopeRow(row);
      if (scope) out.push(scope);
    }
    appScopesCacheKey = cacheKey;
    appScopesCache = out;
    return appScopesCache;
  } catch {
    appScopesCacheKey = cacheKey;
    appScopesCache = [];
    return [];
  }
}

export function listAndroidAppScopes(): AndroidAppScope[] {
  return [{ id: ALL_APP_SCOPE_ID, label: "全部应用", prefixes: [] }, ...parseAndroidAppScopes()];
}

export function getAndroidAppScopeById(scopeId?: string) {
  const sid = String(scopeId || "").trim();
  if (!sid || sid === ALL_APP_SCOPE_ID) return null;
  return parseAndroidAppScopes().find((x) => x.id === sid) || null;
}

export function isExternalAndroidAppScope(scope: AndroidAppScope | null | undefined) {
  return scope?.externalRepo === true;
}

export function resolveAndroidAppScopeRepoRoot(scope: AndroidAppScope) {
  if (scope.repoRoot) return path.resolve(scope.repoRoot);
  throw new Error(`android_root_missing:${scope.id}`);
}

export function getAndroidAppScopePrefixes(scopeId?: string) {
  const scope = getAndroidAppScopeById(scopeId);
  if (!scope) return [];
  if (scope.matchAll) return ["."];
  return scope.prefixes;
}

export function getAndroidScopePrefixesByIds(scopeIds: string[]) {
  const wanted = new Set(scopeIds.map((x) => String(x || "").trim()).filter(Boolean));
  if (!wanted.size) return [] as string[];
  const prefixes: string[] = [];
  for (const scope of parseAndroidAppScopes()) {
    if (!wanted.has(scope.id)) continue;
    if (isExternalAndroidAppScope(scope) && scope.matchAll) continue;
    prefixes.push(...scope.prefixes);
  }
  return [...new Set(prefixes)];
}

export function getExternalAndroidAppScopeIds(scopeIds: string[]) {
  const wanted = new Set(scopeIds.map((x) => String(x || "").trim()).filter(Boolean));
  if (!wanted.size) return [] as string[];
  return parseAndroidAppScopes()
    .filter((scope) => wanted.has(scope.id) && isExternalAndroidAppScope(scope))
    .map((scope) => scope.id);
}

export function getAndroidAppScopeWorkspaceAlias(scopeId?: string) {
  const scope = getAndroidAppScopeById(scopeId);
  if (!scope) return DEFAULT_WORKSPACE_ALIAS;
  return scope.workspaceAlias || DEFAULT_WORKSPACE_ALIAS;
}

export function getHarmonyWorkspaceAliasForScope(scope: AndroidAppScope | null | undefined) {
  if (!scope?.harmonyRepoRoot) return DEFAULT_HARMONY_WORKSPACE_ALIAS;
  return scope.harmonyWorkspaceAlias || DEFAULT_HARMONY_WORKSPACE_ALIAS;
}

export function scopeHasHarmonySource(scope: AndroidAppScope | null | undefined) {
  return !!scope?.harmonyRepoRoot;
}

export function resolveHarmonyAppScopeRepoRoot(scope: AndroidAppScope) {
  if (scope.harmonyRepoRoot) return path.resolve(scope.harmonyRepoRoot);
  throw new Error(`harmony_root_missing:${scope.id}`);
}

export function getHarmonyAppScopePrefixes(scopeId?: string) {
  const scope = getAndroidAppScopeById(scopeId);
  if (!scope?.harmonyRepoRoot) return [];
  if (scope.harmonyMatchAll) return ["."];
  return scope.harmonyPrefixes || [];
}

export function getHarmonyScopePrefixesByIds(scopeIds: string[]) {
  const wanted = new Set(scopeIds.map((x) => String(x || "").trim()).filter(Boolean));
  if (!wanted.size) return [] as string[];
  const prefixes: string[] = [];
  for (const scope of parseAndroidAppScopes()) {
    if (!wanted.has(scope.id) || !scope.harmonyRepoRoot) continue;
    prefixes.push(...getHarmonyAppScopePrefixes(scope.id));
  }
  return [...new Set(prefixes)];
}

export function findHarmonyScopeByWorkspacePath(relativePath: string) {
  const rel = String(relativePath || "").replace(/\\/g, "/");
  return (
    parseAndroidAppScopes().find((scope) => {
      if (!scope.harmonyRepoRoot) return false;
      const alias = getHarmonyWorkspaceAliasForScope(scope);
      return rel.startsWith(`${alias}/`);
    }) || null
  );
}

export function listHarmonyWorkspaceLinks() {
  const seen = new Set<string>();
  const links: Array<{ root: string; alias: string }> = [];
  for (const scope of parseAndroidAppScopes()) {
    if (!scope.harmonyRepoRoot) continue;
    const alias = getHarmonyWorkspaceAliasForScope(scope);
    const root = resolveHarmonyAppScopeRepoRoot(scope);
    const key = `${root}|${alias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ root, alias });
  }
  return links;
}

export function moduleMatchesAppScope(module: string, scopeId?: string) {
  const target = String(module || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!target) return false;
  const scope = getAndroidAppScopeById(scopeId);
  if (!scope) return true;
  if (scope.matchAll) return true;
  const prefixes = scope.prefixes;
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => {
    if (prefix === ".") return true;
    const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return target === prefix || target === prefix.replace(/\/$/, "") || target.startsWith(p);
  });
}

export function encodeScopedRelativePath(scopeId: string, repoRelativePath: string) {
  const rel = repoRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${scopeId}${SCOPE_PATH_SEP}${rel}`;
}

export function decodeScopedRelativePath(relativePath: string) {
  const rel = relativePath.replace(/\\/g, "/");
  const idx = rel.indexOf(SCOPE_PATH_SEP);
  if (idx <= 0) {
    return { scopeId: null as string | null, repoRelativePath: rel };
  }
  return {
    scopeId: rel.slice(0, idx),
    repoRelativePath: rel.slice(idx + SCOPE_PATH_SEP.length),
  };
}

export function buildIndexConfigKey(mainIndexRoots: string[]) {
  const parts = [`main:${mainIndexRoots.join("|")}`];
  for (const scope of parseAndroidAppScopes()) {
    if (!isExternalAndroidAppScope(scope)) continue;
    let repoRoot = "";
    try {
      repoRoot = resolveAndroidAppScopeRepoRoot(scope);
    } catch {
      repoRoot = scope.repoRoot || "";
    }
    parts.push(
      `${scope.id}:${scope.repositoryId || "source"}=${repoRoot}:${(scope.indexRoots || ["."]).join("|")}`,
    );
  }
  for (const scope of parseAndroidAppScopes()) {
    if (!scope.harmonyRepoRoot) continue;
    let repoRoot = "";
    try {
      repoRoot = resolveHarmonyAppScopeRepoRoot(scope);
    } catch {
      repoRoot = scope.harmonyRepoRoot || "";
    }
    const roots = scope.harmonyMatchAll ? ["."] : scope.harmonyPrefixes || [];
    parts.push(`harmony:${scope.id}:${scope.harmonyRepositoryId || "source"}=${repoRoot}:${roots.join("|")}`);
  }
  return parts.join("||");
}
