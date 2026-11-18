import {
  getAndroidAppScopeById,
  parseAndroidAppScopes,
} from "@/lib/android-app-scopes";
import { HARMONY_MODULE_SEGMENT, MONOREPO_PROJECT_ID } from "@/lib/module-prefix-constants";
import {
  isHarmonyScopedModulePrefix,
  normalizeModulePrefix,
  parseScopedModulePrefix as parseScopedModulePrefixCore,
  type ModulePrefixPlatform,
  type ParsedModulePrefix,
} from "@/lib/module-prefix-parse";

export type { ModulePrefixPlatform, ParsedModulePrefix } from "@/lib/module-prefix-parse";
export { isHarmonyScopedModulePrefix, normalizeModulePrefix } from "@/lib/module-prefix-parse";

export function toScopedModulePrefix(scopeId: string, modulePath: string) {
  const module = normalizeModulePrefix(modulePath).replace(/\/$/, "");
  if (!module) return "";
  return `${scopeId}/${module}/`;
}

export function toHarmonyScopedModulePrefix(scopeId: string, modulePath: string) {
  const module = normalizeModulePrefix(modulePath).replace(/\/$/, "");
  if (!module || module === ".") return `${scopeId}/${HARMONY_MODULE_SEGMENT}/`;
  return `${scopeId}/${HARMONY_MODULE_SEGMENT}/${module}/`;
}

export function parseScopedModulePrefix(prefix: string): ParsedModulePrefix & { workspaceAlias?: string } {
  const parsed = parseScopedModulePrefixCore(prefix, {
    projectLabels: Object.fromEntries(parseAndroidAppScopes().map((s) => [s.id, s.label])),
  });
  if (parsed.projectId === MONOREPO_PROJECT_ID) {
    return { ...parsed, workspaceAlias: "android-src" };
  }
  const scope = getAndroidAppScopeById(parsed.projectId);
  return {
    ...parsed,
    projectLabel: scope?.label || parsed.projectLabel,
    workspaceAlias:
      parsed.platform === "harmony"
        ? scope?.harmonyWorkspaceAlias || "harmony-src"
        : scope?.workspaceAlias || "android-src",
  };
}

const SHARED_MONOREPO_ROOTS = new Set(["app", "base", "component", "feature", "library"]);

function isSharedMonorepoPrefix(prefix: string) {
  const normalized = normalizeModulePrefix(prefix).replace(/\/$/, "");
  if (normalized.startsWith(`${MONOREPO_PROJECT_ID}/`)) {
    return true;
  }
  const first = normalized.split("/")[0];
  return SHARED_MONOREPO_ROOTS.has(first);
}

const MONOREPO_SHARED_NOTE = "大仓内多 App 共享";

export function collectDefaultModulePrefixes() {
  const out: Array<{ prefix: string; note?: string }> = [];
  const seen = new Set<string>();

  const push = (prefix: string, note?: string) => {
    const normalized = normalizeModulePrefix(prefix);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ prefix: normalized, note });
  };

  for (const scope of parseAndroidAppScopes()) {
    const androidWorkspace = scope.workspaceAlias || (scope.externalRepo ? `${scope.id.toLowerCase()}-src` : "android-src");
    const androidNote = `${scope.label} · ${androidWorkspace}/`;
    const modulePaths = new Set<string>();

    for (const root of scope.indexRoots || []) {
      const normalized = root.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!normalized || normalized === ".") continue;
      if (scope.externalRepo) modulePaths.add(normalized);
      else push(toScopedModulePrefix(MONOREPO_PROJECT_ID, normalized), MONOREPO_SHARED_NOTE);
    }
    for (const p of scope.prefixes) {
      const normalized = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!normalized || normalized === ".") continue;
      if (!scope.externalRepo && isSharedMonorepoPrefix(normalized)) {
        push(
          toScopedModulePrefix(MONOREPO_PROJECT_ID, normalized.split("/")[0]),
          MONOREPO_SHARED_NOTE,
        );
      } else {
        modulePaths.add(normalized);
      }
    }

    for (const modulePath of modulePaths) {
      push(toScopedModulePrefix(scope.id, modulePath), androidNote);
    }

    if (!scope.harmonyRepoRoot) continue;
    const harmonyWorkspace = scope.harmonyWorkspaceAlias || "harmony-src";
    const harmonyNote = `${scope.label} · ${harmonyWorkspace}/`;
    const harmonyPaths = scope.harmonyMatchAll ? ["."] : scope.harmonyPrefixes || [];
    for (const modulePath of harmonyPaths) {
      push(toHarmonyScopedModulePrefix(scope.id, modulePath), harmonyNote);
    }
  }

  return out;
}

/** 旧版扁平前缀 → 新版带项目前缀（用于迁移） */
export const LEGACY_FLAT_PREFIX_MIGRATIONS: Array<{ legacy: string; scoped: string[] }> = [
  { legacy: "feature/", scoped: ["demo-project/feature/"] },
  { legacy: "library/", scoped: ["demo-project/library/"] },
  { legacy: "app/", scoped: ["demo-project/app/"] },
];
