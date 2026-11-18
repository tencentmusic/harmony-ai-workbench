import path from "node:path";
import {
  ALL_APP_SCOPE_ID,
  buildIndexConfigKey,
  encodeScopedRelativePath,
  getAndroidAppScopeById,
  getAndroidAppScopePrefixes,
  getAndroidScopePrefixesByIds,
  getExternalAndroidAppScopeIds,
  isExternalAndroidAppScope,
  listAndroidAppScopes,
  parseAndroidAppScopes,
  resolveAndroidAppScopeRepoRoot,
  scopeHasHarmonySource,
  SCOPE_PATH_SEP,
  type AndroidAppScope,
} from "@/lib/android-app-scopes";
import {
  resolveSharedAndroidMonorepoIndexRoots,
  resolveSharedAndroidMonorepoPath,
} from "@/lib/workspace-apps-config";
import { HARMONY_SCOPE_PATH_MARKER, indexHarmonyScope } from "@/lib/harmony-class-index";
import { collectSourceFiles as collectGitSourceFiles } from "@/lib/index-source-files";
import type { ClassIndexSlice } from "@/lib/class-index-slices";
import { prisma } from "@/lib/prisma";

const DEFAULT_INDEX_ROOTS = ["library", "feature"];
const DEFAULT_LIMIT = 20;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REBUILD_CHUNK_SIZE = 120;
const EXTERNAL_SCOPE_PATH_MARKER = "%::%";

export type { AndroidAppScope } from "@/lib/android-app-scopes";
export {
  ALL_APP_SCOPE_ID,
  getAndroidAppScopePrefixes,
  getAndroidScopePrefixesByIds,
  listAndroidAppScopes,
  moduleMatchesAppScope,
} from "@/lib/android-app-scopes";

export type AndroidClassIndexItem = {
  className: string;
  fqn: string;
  module: string;
  filePath: string;
  relativePath: string;
};

const META_CHECK_INTERVAL_MS = 30_000;
const SEARCH_RESULT_CACHE_TTL_MS = 10_000;
const SEARCH_RESULT_CACHE_MAX = 300;

let initialized = false;
let buildingPromise: Promise<void> | null = null;
let bootWarmupStarted = false;
let metaFreshUntil = 0;
const searchResultCache = new Map<string, { expiresAt: number; rows: AndroidClassIndexItem[] }>();

type IndexRow = {
  class_name: string;
  fqn: string;
  module: string;
  relative_path: string;
  file_path: string;
  score?: number;
};

function getRepoRoot() {
  const repoRoot = resolveSharedAndroidMonorepoPath();
  if (!repoRoot) throw new Error("android_root_missing");
  return path.resolve(repoRoot);
}

export function getAndroidClassIndexRoots() {
  const configured = resolveSharedAndroidMonorepoIndexRoots();
  return configured.length ? configured : DEFAULT_INDEX_ROOTS;
}

function getCacheTtlMs() {
  const n = Number(process.env.ANDROID_CLASS_INDEX_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 10_000 ? n : DEFAULT_CACHE_TTL_MS;
}

function parseIndexItem(repoRoot: string, relPath: string, options?: { allowFlavorSourceSet?: boolean }) {
  const normalized = relPath.replace(/\\/g, "/");
  const javaRoot = "/src/main/java/";
  const kotlinRoot = "/src/main/kotlin/";
  let marker = normalized.includes(javaRoot) ? javaRoot : normalized.includes(kotlinRoot) ? kotlinRoot : "";
  if (!marker && options?.allowFlavorSourceSet) {
    const flavorMatch = normalized.match(/\/src\/[^/]+\/(java|kotlin)\//i);
    if (flavorMatch?.index != null) {
      marker = normalized.slice(flavorMatch.index, flavorMatch.index + flavorMatch[0].length);
    }
  }
  if (!marker) return null;
  const markerIdx = normalized.indexOf(marker);
  if (markerIdx <= 0) return null;
  const module = normalized.slice(0, markerIdx);
  const packagePath = normalized.slice(markerIdx + marker.length).replace(/\.(kt|java)$/i, "");
  if (!packagePath) return null;
  const fqn = packagePath.split("/").filter(Boolean).join(".");
  const className = fqn.split(".").at(-1) || "";
  if (!className) return null;
  return {
    className,
    fqn,
    module,
    relativePath: normalized,
    filePath: path.resolve(repoRoot, normalized),
  };
}

async function collectAndroidSourceFiles(repoRoot: string, roots: string[]) {
  return collectGitSourceFiles(repoRoot, roots, [".kt", ".java"]);
}

function isBusinessSourcePath(relPath: string) {
  const normalized = relPath.replace(/\\/g, "/");
  return !/\/src\/androidTest\//i.test(normalized) && !/\/src\/test\//i.test(normalized);
}

async function ensureIndexTables() {
  if (initialized) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS android_class_index (
      class_name TEXT NOT NULL,
      fqn TEXT NOT NULL,
      module TEXT NOT NULL,
      relative_path TEXT NOT NULL PRIMARY KEY,
      file_path TEXT NOT NULL
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_aci_fqn ON android_class_index(fqn);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_aci_class_name ON android_class_index(class_name);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_aci_module ON android_class_index(module);`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS android_class_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  initialized = true;
}

async function indexMainRepo(repoRoot: string, roots: string[]) {
  const files = await collectAndroidSourceFiles(repoRoot, roots);
  const rows: AndroidClassIndexItem[] = [];
  for (const rel of files) {
    if (!isBusinessSourcePath(rel)) continue;
    const parsed = parseIndexItem(repoRoot, rel, { allowFlavorSourceSet: true });
    if (parsed) rows.push(parsed);
  }
  return rows;
}

async function getMeta(key: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: string | null }>>(
    `SELECT value FROM android_class_index_meta WHERE key = ? LIMIT 1`,
    key
  );
  return rows[0]?.value || "";
}

async function setMeta(key: string, value: string) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO android_class_index_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    key,
    value
  );
}

async function getIndexCount() {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(*) as c FROM android_class_index`);
  return Number(rows[0]?.c || 0);
}

async function indexExternalScope(scope: AndroidAppScope) {
  const repoRoot = resolveAndroidAppScopeRepoRoot(scope);
  const roots = scope.indexRoots?.length ? scope.indexRoots : ["."];
  const files = await collectAndroidSourceFiles(repoRoot, roots);
  const rows: AndroidClassIndexItem[] = [];
  for (const rel of files) {
    if (!isBusinessSourcePath(rel)) continue;
    const parsed = parseIndexItem(repoRoot, rel, { allowFlavorSourceSet: true });
    if (!parsed) continue;
    rows.push({
      ...parsed,
      relativePath: encodeScopedRelativePath(scope.id, parsed.relativePath),
    });
  }
  return rows;
}

async function insertIndexRows(
  tx: { $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> },
  rows: AndroidClassIndexItem[],
) {
  for (let i = 0; i < rows.length; i += REBUILD_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + REBUILD_CHUNK_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((row) => [row.className, row.fqn, row.module, row.relativePath, row.filePath]);
    await tx.$executeRawUnsafe(
      `
          INSERT INTO android_class_index (class_name, fqn, module, relative_path, file_path)
          VALUES ${placeholders}
        `,
      ...params,
    );
  }
}

async function replaceIndexRows(
  deletes: Array<{ sql: string; params: unknown[] }>,
  rows: AndroidClassIndexItem[],
) {
  await prisma.$transaction(
    async (tx) => {
      for (const item of deletes) {
        await tx.$executeRawUnsafe(item.sql, ...item.params);
      }
      await insertIndexRows(tx, rows);
    },
    { maxWait: 10_000, timeout: 180_000 },
  );
}

function enqueueIndexJob<T>(fn: () => Promise<T>): Promise<T> {
  const prev = buildingPromise;
  const next = (async () => {
    if (prev) await prev.catch(() => {});
    return fn();
  })();
  buildingPromise = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function collectSliceRows(slice: ClassIndexSlice): Promise<{
  rows: AndroidClassIndexItem[];
  deleteSql: { sql: string; params: unknown[] };
}> {
  if (slice.kind === "main_android") {
    const roots = slice.pathPrefix ? [slice.pathPrefix] : getAndroidClassIndexRoots();
    const rows = await indexMainRepo(getRepoRoot(), roots);
    if (slice.pathPrefix) {
      const prefix = slice.pathPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return {
        rows,
        deleteSql: {
          sql: `DELETE FROM android_class_index WHERE relative_path NOT LIKE ? ESCAPE '\\' AND relative_path NOT LIKE ? ESCAPE '\\' AND (relative_path = ? OR relative_path LIKE ? ESCAPE '\\')`,
          params: [EXTERNAL_SCOPE_PATH_MARKER, `${HARMONY_SCOPE_PATH_MARKER}%`, prefix, `${prefix}/%`],
        },
      };
    }
    return {
      rows,
      deleteSql: {
        sql: `DELETE FROM android_class_index WHERE relative_path NOT LIKE ? ESCAPE '\\' AND relative_path NOT LIKE ? ESCAPE '\\'`,
        params: [EXTERNAL_SCOPE_PATH_MARKER, `${HARMONY_SCOPE_PATH_MARKER}%`],
      },
    };
  }
  if (slice.kind === "android_scope") {
    const scope = getAndroidAppScopeById(slice.scopeId);
    if (!scope || !isExternalAndroidAppScope(scope)) {
      throw new Error(`class_index_scope_missing:${slice.scopeId}`);
    }
    return {
      rows: await indexExternalScope(scope),
      deleteSql: {
        sql: `DELETE FROM android_class_index WHERE relative_path LIKE ? ESCAPE '\\'`,
        params: [`${scope.id}${SCOPE_PATH_SEP}%`],
      },
    };
  }
  const scope = getAndroidAppScopeById(slice.scopeId);
  if (!scopeHasHarmonySource(scope)) {
    throw new Error(`class_index_harmony_missing:${slice.scopeId}`);
  }
  if (!scope) throw new Error(`class_index_scope_missing:${slice.scopeId}`);
  const rows = await indexHarmonyScope(scope);
  return {
    rows,
    deleteSql: {
      sql: `DELETE FROM android_class_index WHERE relative_path LIKE ? ESCAPE '\\'`,
      params: [harmonyScopeLike(scope.id)],
    },
  };
}

async function rebuildIndex() {
  const repoRoot = getRepoRoot();
  const roots = getAndroidClassIndexRoots();
  const rows: AndroidClassIndexItem[] = await indexMainRepo(repoRoot, roots);
  for (const scope of parseAndroidAppScopes()) {
    if (!isExternalAndroidAppScope(scope)) continue;
    try {
      const externalRows = await indexExternalScope(scope);
      rows.push(...externalRows);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[indexing] skip external scope ${scope.id}: ${msg}`);
    }
  }
  for (const scope of parseAndroidAppScopes()) {
    if (!scopeHasHarmonySource(scope)) continue;
    try {
      const harmonyRows = await indexHarmonyScope(scope);
      rows.push(...harmonyRows);
      console.info(`[indexing] harmony scope ${scope.id}: ${harmonyRows.length} symbols`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[indexing] skip harmony scope ${scope.id}: ${msg}`);
    }
  }
  await replaceIndexRows([{ sql: `DELETE FROM android_class_index`, params: [] }], rows);
  await setMeta("config_key", buildIndexConfigKey(roots));
  await setMeta("built_at", String(Date.now()));
  metaFreshUntil = Date.now() + META_CHECK_INTERVAL_MS;
  searchResultCache.clear();
}

async function ensureFreshIndex() {
  await ensureIndexTables();
  if (Date.now() < metaFreshUntil) return;
  const roots = getAndroidClassIndexRoots();
  const configKey = buildIndexConfigKey(roots);
  const builtAt = Number(await getMeta("built_at") || 0);
  const builtConfigKey = await getMeta("config_key");
  const ttl = getCacheTtlMs();
  const staleByEmpty = !builtAt;
  const staleByTtl = !!builtAt && Date.now() - builtAt > ttl;
  const staleByConfig = builtConfigKey !== configKey;
  const stale = staleByEmpty || staleByTtl || staleByConfig;
  if (!stale) {
    metaFreshUntil = Date.now() + META_CHECK_INTERVAL_MS;
    return;
  }
  if (buildingPromise) return buildingPromise;
  const reasons = [
    staleByEmpty ? "empty" : "",
    staleByTtl ? "ttl" : "",
    staleByConfig ? "config" : "",
  ].filter(Boolean);
  const startedAt = Date.now();
  console.info(`[indexing] stale detected, rebuilding (${reasons.join(",") || "unknown"})`);
  return enqueueIndexJob(async () => {
    await rebuildIndex();
    console.info(`[indexing] rebuild finished in ${Date.now() - startedAt}ms`);
  });
}

export async function rebuildAndroidClassIndexSlices(slices: ClassIndexSlice[]) {
  if (!slices.length) return { count: 0 };
  await ensureIndexTables();
  return enqueueIndexJob(async () => {
    const startedAt = Date.now();
    const rows: AndroidClassIndexItem[] = [];
    const deletes: Array<{ sql: string; params: unknown[] }> = [];
    for (const slice of slices) {
      const collected = await collectSliceRows(slice);
      rows.push(...collected.rows);
      deletes.push(collected.deleteSql);
      console.info(`[indexing] slice ${JSON.stringify(slice)} rows=${collected.rows.length}`);
    }
    await replaceIndexRows(deletes, rows);
    await setMeta("built_at", String(Date.now()));
    metaFreshUntil = Date.now() + META_CHECK_INTERVAL_MS;
    searchResultCache.clear();
    console.info(`[indexing] slice rebuild finished count=${rows.length} elapsedMs=${Date.now() - startedAt}`);
    return { count: rows.length };
  });
}

export async function forceRebuildAndroidClassIndex() {
  await ensureIndexTables();
  await enqueueIndexJob(async () => {
    await rebuildIndex();
  });
  metaFreshUntil = Date.now() + META_CHECK_INTERVAL_MS;
  searchResultCache.clear();
  const count = await getIndexCount();
  const harmonyCountRows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
    `SELECT COUNT(*) as c FROM android_class_index WHERE relative_path LIKE ? ESCAPE '\\'`,
    `${HARMONY_SCOPE_PATH_MARKER}%`,
  );
  return {
    count,
    harmonyCount: Number(harmonyCountRows[0]?.c || 0),
    roots: getAndroidClassIndexRoots(),
  };
}

export async function warmupAndroidClassIndex() {
  await ensureFreshIndex();
  const roots = getAndroidClassIndexRoots();
  return { count: await getIndexCount(), roots };
}

export function triggerAndroidClassIndexWarmup() {
  if (bootWarmupStarted) return;
  const prewarmFlag = String(process.env.ANDROID_CLASS_INDEX_PREWARM_ON_BOOT || "0").trim().toLowerCase();
  if (prewarmFlag === "0" || prewarmFlag === "false" || prewarmFlag === "off") return;
  bootWarmupStarted = true;
  const delayMs = Math.max(0, Number(process.env.ANDROID_CLASS_INDEX_PREWARM_DELAY_MS || 5000) || 5000);
  setTimeout(() => {
    const startedAt = Date.now();
    console.info(`[indexing] boot warmup started (delay=${delayMs}ms)`);
    void warmupAndroidClassIndex()
      .then((result) => {
        console.info(
          `[indexing] boot warmup done: count=${result.count}, roots=${result.roots.join(",")}, elapsedMs=${Date.now() - startedAt}`
        );
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[indexing] boot warmup failed: ${msg}`);
      });
  }, delayMs);
}

function mapRow(row: IndexRow): AndroidClassIndexItem {
  return {
    className: row.class_name,
    fqn: row.fqn,
    module: row.module,
    relativePath: row.relative_path,
    filePath: row.file_path,
  };
}

function buildPrefixScopeSql(scopePrefixes: string[]) {
  if (!scopePrefixes.length) {
    return { sql: "", params: [] as string[] };
  }
  const sql = ` AND (${scopePrefixes.map(() => `(module = ? COLLATE NOCASE OR module LIKE ? COLLATE NOCASE)`).join(" OR ")})`;
  const params = scopePrefixes.flatMap((x) => {
    const p = x.replace(/\/+$/g, "");
    return [p, `${p}/%`];
  });
  return { sql, params };
}

function harmonyScopeLike(scopeId: string) {
  return `${HARMONY_SCOPE_PATH_MARKER}${scopeId}${SCOPE_PATH_SEP}%`;
}

function buildHarmonyScopeSql(scopeId: string) {
  return { sql: `relative_path LIKE ? ESCAPE '\\'`, params: [harmonyScopeLike(scopeId)] };
}

function buildScopeFilterSql(scopeId?: string, allowedScopeIds: string[] = []) {
  const sid = String(scopeId || "").trim();
  const allowed = [...new Set(allowedScopeIds.map((x) => String(x || "").trim()).filter(Boolean))];

  if (sid && sid !== ALL_APP_SCOPE_ID) {
    const scope = getAndroidAppScopeById(sid);
    const clauses: string[] = [];
    const params: string[] = [];
    if (scope && isExternalAndroidAppScope(scope)) {
      clauses.push(`relative_path LIKE ? ESCAPE '\\'`);
      params.push(`${scope.id}${SCOPE_PATH_SEP}%`);
    } else {
      const prefixes = getAndroidAppScopePrefixes(sid);
      const prefixSql = buildPrefixScopeSql(prefixes);
      if (prefixSql.sql) {
        clauses.push(
          `(relative_path NOT LIKE ? ESCAPE '\\' AND relative_path NOT LIKE ? ESCAPE '\\'${prefixSql.sql})`,
        );
        params.push(EXTERNAL_SCOPE_PATH_MARKER, `${HARMONY_SCOPE_PATH_MARKER}%`, ...prefixSql.params);
      }
    }
    if (scopeHasHarmonySource(scope)) {
      if (!scope) throw new Error(`class_index_scope_missing:${sid}`);
      const harmonySql = buildHarmonyScopeSql(scope.id);
      clauses.push(harmonySql.sql);
      params.push(...harmonySql.params);
    }
    if (!clauses.length) return { sql: "", params: [] as string[] };
    return { sql: ` AND (${clauses.join(" OR ")})`, params };
  }

  if (allowed.length) {
    const mainPrefixes = getAndroidScopePrefixesByIds(allowed);
    const externalIds = getExternalAndroidAppScopeIds(allowed);
    const clauses: string[] = [];
    const params: string[] = [];
    if (mainPrefixes.length) {
      const prefixSql = buildPrefixScopeSql(mainPrefixes);
      clauses.push(`(relative_path NOT LIKE ? ESCAPE '\\' AND relative_path NOT LIKE ? ESCAPE '\\'${prefixSql.sql})`);
      params.push(EXTERNAL_SCOPE_PATH_MARKER, `${HARMONY_SCOPE_PATH_MARKER}%`, ...prefixSql.params);
    }
    for (const externalId of externalIds) {
      clauses.push(`relative_path LIKE ? ESCAPE '\\'`);
      params.push(`${externalId}${SCOPE_PATH_SEP}%`);
    }
    for (const allowedId of allowed) {
      const scope = getAndroidAppScopeById(allowedId);
      if (!scopeHasHarmonySource(scope)) continue;
      if (!scope) continue;
      const harmonySql = buildHarmonyScopeSql(scope.id);
      clauses.push(harmonySql.sql);
      params.push(...harmonySql.params);
    }
    if (!clauses.length) return { sql: "", params: [] };
    return { sql: ` AND (${clauses.join(" OR ")})`, params };
  }

  const prefixSql = buildPrefixScopeSql([]);
  return prefixSql;
}

export async function getAndroidClassIndex() {
  await ensureFreshIndex();
  const rows = await prisma.$queryRawUnsafe<IndexRow[]>(
    `SELECT class_name, fqn, module, relative_path, file_path FROM android_class_index ORDER BY fqn ASC`
  );
  return rows.map(mapRow);
}

export async function searchAndroidClasses(keyword: string, limit = DEFAULT_LIMIT, scopeId?: string, allowedScopeIds: string[] = []) {
  const sid = String(scopeId || "").trim();
  const scopeFilter = buildScopeFilterSql(sid && sid !== ALL_APP_SCOPE_ID ? sid : undefined, allowedScopeIds);
  return searchAndroidClassesByScopeFilter(keyword, limit, scopeFilter);
}

export async function findAndroidClassesByFqn(
  fqn: string,
  limit = DEFAULT_LIMIT,
  options?: { scopeId?: string; allowedScopeIds?: string[]; module?: string }
) {
  const targetFqn = fqn.trim();
  if (!targetFqn) return [] as AndroidClassIndexItem[];
  const rowLimit = Math.max(1, Math.min(100, limit));
  await ensureFreshIndex();
  const scopeFilter = buildScopeFilterSql(options?.scopeId, options?.allowedScopeIds || []);
  const targetModule = options?.module?.trim();
  const moduleSql = targetModule ? " AND module = ? COLLATE NOCASE" : "";
  const rows = await prisma.$queryRawUnsafe<IndexRow[]>(
    `
      SELECT class_name, fqn, module, relative_path, file_path
      FROM android_class_index
      WHERE fqn = ? COLLATE NOCASE${moduleSql}${scopeFilter.sql}
      ORDER BY
        CASE
          WHEN module = 'library/common' THEN 0
          WHEN lower(module) LIKE '%vemus%' THEN 2
          ELSE 1
        END,
        length(module) ASC,
        module ASC
      LIMIT ?
    `,
    targetFqn,
    ...(targetModule ? [targetModule] : []),
    ...scopeFilter.params,
    rowLimit
  );
  return rows.map(mapRow);
}

export async function findAndroidClassesByExactName(
  className: string,
  limit = DEFAULT_LIMIT,
  scopePrefixes: string[] = [],
  options?: { scopeId?: string; allowedScopeIds?: string[] }
) {
  const q = className.trim();
  if (!q) return [] as AndroidClassIndexItem[];
  const dedupedScopePrefixes = [...new Set(scopePrefixes.map((x) => String(x || "").trim()).filter(Boolean))].sort();
  const rowLimit = Math.max(1, Math.min(100, limit));
  await ensureFreshIndex();

  const scopeFilter =
    options?.scopeId && String(options.scopeId).trim() && String(options.scopeId).trim() !== ALL_APP_SCOPE_ID
      ? buildScopeFilterSql(options.scopeId, options.allowedScopeIds || [])
      : options?.allowedScopeIds?.length
        ? buildScopeFilterSql(undefined, options.allowedScopeIds)
        : dedupedScopePrefixes.length
          ? {
              sql: `${buildPrefixScopeSql(dedupedScopePrefixes).sql} AND relative_path NOT LIKE ? ESCAPE '\\'`,
              params: [...buildPrefixScopeSql(dedupedScopePrefixes).params, EXTERNAL_SCOPE_PATH_MARKER],
            }
          : { sql: "", params: [] as string[] };

  const rows = await prisma.$queryRawUnsafe<IndexRow[]>(
    `
      SELECT class_name, fqn, module, relative_path, file_path
      FROM android_class_index
      WHERE class_name = ? COLLATE NOCASE${scopeFilter.sql}
      ORDER BY
        CASE
          WHEN module = 'library/common' THEN 0
          WHEN lower(module) LIKE '%vemus%' THEN 2
          ELSE 1
        END,
        length(module) ASC,
        module ASC
      LIMIT ?
    `,
    q,
    ...scopeFilter.params,
    rowLimit
  );
  return rows.map(mapRow);
}

async function searchAndroidClassesByScopeFilter(keyword: string, limit: number, scopeFilter: { sql: string; params: string[] }) {
  const q = keyword.trim().toLowerCase();
  if (!q) return [] as AndroidClassIndexItem[];
  const rowLimit = Math.max(1, Math.min(100, limit));
  const cacheKey = `${q}::${rowLimit}::scope::${scopeFilter.sql}::${scopeFilter.params.join("|")}`;
  const cacheHit = searchResultCache.get(cacheKey);
  if (cacheHit && cacheHit.expiresAt > Date.now()) return cacheHit.rows;
  await ensureFreshIndex();
  const prefix = `${q}%`;
  const contains = `%${q}%`;
  const rows = await prisma.$queryRawUnsafe<IndexRow[]>(
    `
      SELECT * FROM (
        SELECT
          class_name, fqn, module, relative_path, file_path,
          CASE
            WHEN class_name = ? COLLATE NOCASE THEN 10000
            WHEN class_name LIKE ? COLLATE NOCASE THEN 8000 - length(class_name)
            WHEN fqn LIKE ? COLLATE NOCASE THEN 7000 - length(fqn)
            WHEN instr(lower(class_name), ?) > 0 THEN 5000 - instr(lower(class_name), ?)
            WHEN instr(lower(fqn), ?) > 0 THEN 3000 - instr(lower(fqn), ?)
            WHEN instr(lower(relative_path), ?) > 0 THEN 1000 - instr(lower(relative_path), ?)
            ELSE -1
          END AS score
        FROM android_class_index
        WHERE (
          class_name LIKE ? COLLATE NOCASE
          OR fqn LIKE ? COLLATE NOCASE
          OR class_name LIKE ? COLLATE NOCASE
          OR fqn LIKE ? COLLATE NOCASE
          OR relative_path LIKE ? COLLATE NOCASE
        )${scopeFilter.sql}
      ) t
      WHERE score >= 0
      ORDER BY score DESC, fqn ASC
      LIMIT ?
    `,
    q,
    prefix,
    prefix,
    prefix,
    prefix,
    q,
    q,
    q,
    q,
    q,
    q,
    contains,
    contains,
    contains,
    ...scopeFilter.params,
    rowLimit
  );
  const mapped = rows.map(mapRow);
  if (searchResultCache.size >= SEARCH_RESULT_CACHE_MAX) {
    const oldestKey = searchResultCache.keys().next().value;
    if (oldestKey) searchResultCache.delete(oldestKey);
  }
  searchResultCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_RESULT_CACHE_TTL_MS, rows: mapped });
  return mapped;
}

export async function searchAndroidClassesByPrefixes(
  keyword: string,
  limit = DEFAULT_LIMIT,
  scopePrefixes: string[] = [],
  allowedScopeIds: string[] = [],
  scopeId?: string
) {
  const q = keyword.trim().toLowerCase();
  if (!q) return [] as AndroidClassIndexItem[];
  const sid = String(scopeId || "").trim();
  const dedupedScopePrefixes = [...new Set(scopePrefixes.map((x) => String(x || "").trim()).filter(Boolean))].sort();

  const scopeFilter =
    sid && sid !== ALL_APP_SCOPE_ID
      ? buildScopeFilterSql(sid, allowedScopeIds)
      : allowedScopeIds.length
        ? buildScopeFilterSql(undefined, allowedScopeIds)
        : dedupedScopePrefixes.length
          ? {
              sql: `${buildPrefixScopeSql(dedupedScopePrefixes).sql} AND relative_path NOT LIKE ? ESCAPE '\\'`,
              params: [...buildPrefixScopeSql(dedupedScopePrefixes).params, EXTERNAL_SCOPE_PATH_MARKER],
            }
          : { sql: "", params: [] as string[] };

  return searchAndroidClassesByScopeFilter(keyword, limit, scopeFilter);
}

export async function resolveAndroidClassByIndex(classFqn: string, module?: string, scopeId?: string) {
  const targetFqn = classFqn.trim();
  if (!targetFqn) return null;
  await ensureFreshIndex();
  const targetModule = module?.trim();
  const scopeFilter = buildScopeFilterSql(scopeId);
  const rows = targetModule
    ? await prisma.$queryRawUnsafe<IndexRow[]>(
        `
          SELECT class_name, fqn, module, relative_path, file_path
          FROM android_class_index
          WHERE fqn = ? AND module = ?${scopeFilter.sql}
          ORDER BY fqn ASC
        `,
        targetFqn,
        targetModule,
        ...scopeFilter.params
      )
    : await prisma.$queryRawUnsafe<IndexRow[]>(
        `
          SELECT class_name, fqn, module, relative_path, file_path
          FROM android_class_index
          WHERE fqn = ?${scopeFilter.sql}
          ORDER BY module ASC
        `,
        targetFqn,
        ...scopeFilter.params
      );
  const exact = rows.map(mapRow);
  if (!exact.length) return null;
  if (exact.length > 1 && !targetModule) {
    return {
      ambiguous: true as const,
      candidates: exact.map((x) => ({ module: x.module, filePath: x.filePath })),
    };
  }
  const first = exact[0];
  return {
    ambiguous: false as const,
    module: first.module,
    filePath: first.filePath,
  };
}
