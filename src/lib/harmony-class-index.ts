import fs from "node:fs/promises";
import path from "node:path";
import {
  getHarmonyAppScopePrefixes,
  resolveHarmonyAppScopeRepoRoot,
  type AndroidAppScope,
} from "@/lib/android-app-scopes";
import {
  buildHarmonySyntheticFqn,
  encodeHarmonyScopedRelativePath,
} from "@/lib/harmony-scoped-path";
import { collectSourceFiles } from "@/lib/index-source-files";

export type HarmonyClassIndexItem = {
  className: string;
  fqn: string;
  module: string;
  relativePath: string;
  filePath: string;
};

export { HARMONY_SCOPE_PATH_MARKER, buildHarmonySyntheticFqn, encodeHarmonyScopedRelativePath } from "@/lib/harmony-scoped-path";

const EXPORT_SYMBOL_RE =
  /export\s+(?:default\s+)?(?:abstract\s+)?(?:struct|class|interface|enum|function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

function isBusinessHarmonyPath(relPath: string) {
  const normalized = relPath.replace(/\\/g, "/");
  return (
    !/\/src\/(test|ohosTest|mock)\//i.test(normalized) &&
    !/\/BuildProfile\.ets$/i.test(normalized) &&
    !/\/oh_modules\//i.test(normalized)
  );
}

function resolveHarmonyModule(relPath: string) {
  const normalized = relPath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

export function extractHarmonyExportSymbols(source: string) {
  const names = new Set<string>();
  for (const m of source.matchAll(EXPORT_SYMBOL_RE)) {
    const name = String(m[1] || "").trim();
    if (name) names.add(name);
  }
  if (!names.size) {
    const fileMatch = source.match(/@Entry\s[\s\S]*?struct\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const entryName = fileMatch?.[1]?.trim();
    if (entryName) names.add(entryName);
  }
  return [...names];
}

async function parseHarmonyFile(scope: AndroidAppScope, repoRoot: string, relPath: string) {
  const absPath = path.resolve(repoRoot, relPath);
  let source = "";
  try {
    source = await fs.readFile(absPath, "utf8");
  } catch {
    return [] as HarmonyClassIndexItem[];
  }
  const symbols = extractHarmonyExportSymbols(source);
  if (!symbols.length) return [];
  const module = resolveHarmonyModule(relPath);
  return symbols.map((symbol) => ({
    className: symbol,
    fqn: buildHarmonySyntheticFqn(scope.id, symbol),
    module,
    relativePath: encodeHarmonyScopedRelativePath(scope.id, relPath, symbol),
    filePath: absPath,
  }));
}

export async function indexHarmonyScope(scope: AndroidAppScope) {
  if (!scope.harmonyRepoRoot) return [] as HarmonyClassIndexItem[];
  const repoRoot = resolveHarmonyAppScopeRepoRoot(scope);
  const roots = scope.harmonyMatchAll ? ["."] : getHarmonyAppScopePrefixes(scope.id);
  const files = (await collectSourceFiles(repoRoot, roots, [".ets"])).filter(isBusinessHarmonyPath);
  const rows: HarmonyClassIndexItem[] = [];
  for (const rel of files) {
    rows.push(...(await parseHarmonyFile(scope, repoRoot, rel)));
  }
  return rows;
}
