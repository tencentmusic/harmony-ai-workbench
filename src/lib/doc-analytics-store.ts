import { randomUUID } from "node:crypto";
import { countMigrationDocs, listMigrationMarkdownDocuments, migrationRelPathToDocPrefixes } from "@/lib/phase2-docs";
import { listPortalKnowledgeBases, loadWorkspaceAppsConfig } from "@/lib/workspace-apps-config";
import { prisma } from "@/lib/prisma";

export type DocAnalyticsEventType = "page_view" | "search" | "ask_ai";

export type DocAnalyticsIncomingEvent = {
  event: DocAnalyticsEventType;
  docPath: string;
  payload?: Record<string, unknown>;
  ts?: number;
};

const PAGE_VIEW_DEDUP_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

const pageViewDedup = new Map<string, number>();
const askAiDedup = new Map<string, number>();
const ASK_AI_DEDUP_MS = 3 * 1000;
const rateLimit = new Map<string, { windowStart: number; count: number }>();

let initialized = false;

async function ensureDocAnalyticsTable() {
  if (initialized) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS doc_analytics_events (
      id TEXT PRIMARY KEY,
      api_token_id TEXT NOT NULL,
      event TEXT NOT NULL,
      doc_path TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_doc_analytics_event_created ON doc_analytics_events(event, created_at DESC);`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_doc_analytics_doc_created ON doc_analytics_events(doc_path, created_at DESC);`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_doc_analytics_token_created ON doc_analytics_events(api_token_id, created_at DESC);`,
  );
  initialized = true;
}

function safeDecodeUriPath(path: string) {
  if (!/%[0-9A-Fa-f]{2}/.test(path)) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeDocPath(docPath: string) {
  let p = String(docPath || "").trim();
  if (!p) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.split("?")[0].split("#")[0];
  return safeDecodeUriPath(p);
}

function isMigrationDocPath(docPath: string) {
  const p = normalizeDocPath(docPath);
  return listPortalKnowledgeBases("migration", loadWorkspaceAppsConfig())
    .some((source) => p.startsWith(`/knowledge/migration:${source.id}/`));
}

function sanitizePayload(event: DocAnalyticsEventType, payload?: Record<string, unknown>) {
  if (!payload) return null;
  const next: Record<string, unknown> = { ...payload };
  if (event === "search" && typeof next.keyword === "string") {
    next.keyword = next.keyword.trim().slice(0, 100);
  }
  if (event === "ask_ai" && typeof next.classFqn === "string") {
    next.classFqn = next.classFqn.trim().slice(0, 240);
  }
  return JSON.stringify(next);
}

function shouldDropPageView(apiTokenId: string, docPath: string) {
  const key = `${apiTokenId}:${docPath}`;
  const now = Date.now();
  const last = pageViewDedup.get(key) || 0;
  if (now - last < PAGE_VIEW_DEDUP_MS) return true;
  pageViewDedup.set(key, now);
  return false;
}

function shouldDropAskAi(apiTokenId: string, docPath: string, payload?: Record<string, unknown>) {
  const classFqn = typeof payload?.classFqn === "string" ? payload.classFqn.trim() : "";
  if (!classFqn) return false;
  const key = `${apiTokenId}:${docPath}:${classFqn}`;
  const now = Date.now();
  const last = askAiDedup.get(key) || 0;
  if (now - last < ASK_AI_DEDUP_MS) return true;
  askAiDedup.set(key, now);
  return false;
}

function hitRateLimit(apiTokenId: string) {
  const now = Date.now();
  const row = rateLimit.get(apiTokenId);
  if (!row || now - row.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(apiTokenId, { windowStart: now, count: 1 });
    return false;
  }
  row.count += 1;
  if (row.count > RATE_LIMIT_MAX) return true;
  return false;
}

export async function insertDocAnalyticsEvents(apiTokenId: string, events: DocAnalyticsIncomingEvent[]) {
  await ensureDocAnalyticsTable();
  let inserted = 0;
  for (const item of events) {
    if (!item?.event || !isMigrationDocPath(item.docPath)) continue;
    const docPath = normalizeDocPath(item.docPath);
    if (item.event === "page_view" && shouldDropPageView(apiTokenId, docPath)) continue;
    if (item.event === "ask_ai" && shouldDropAskAi(apiTokenId, docPath, item.payload)) continue;
    if (hitRateLimit(apiTokenId)) break;
    await prisma.$executeRawUnsafe(
      `INSERT INTO doc_analytics_events (id, api_token_id, event, doc_path, payload_json) VALUES (?, ?, ?, ?, ?)`,
      randomUUID(),
      apiTokenId,
      item.event,
      docPath,
      sanitizePayload(item.event, item.payload),
    );
    inserted += 1;
  }
  return { inserted };
}

function sinceIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(1, days));
  return d.toISOString();
}

function docPathMatchesRel(relPath: string, libraryId: string, viewedPaths: Set<string>) {
  const prefixes = migrationRelPathToDocPrefixes(relPath, libraryId);
  for (const viewed of viewedPaths) {
    for (const prefix of prefixes) {
      if (viewed === prefix || viewed.startsWith(prefix) || prefix.startsWith(viewed)) return true;
    }
  }
  return false;
}

function mergeHotDocsByPath(rows: Array<{ docPath: string; count: number }>) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const path = normalizeDocPath(row.docPath);
    map.set(path, (map.get(path) || 0) + (Number(row.count) || 0));
  }
  return [...map.entries()]
    .map(([docPath, count]) => ({ docPath, count }))
    .sort((a, b) => b.count - a.count || a.docPath.localeCompare(b.docPath, "zh-CN"))
    .slice(0, 50);
}

export async function getDocAnalyticsSummary(days = 7) {
  await ensureDocAnalyticsTable();
  const since = sinceIso(days);
  const coldSince = sinceIso(30);

  const [hotDocs, personViews, personAskAi, viewedCold] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ docPath: string; count: number }>>(
      `SELECT doc_path AS docPath, COUNT(*) AS count
       FROM doc_analytics_events
       WHERE event = 'page_view' AND created_at >= ?
       GROUP BY doc_path
       ORDER BY count DESC
       LIMIT 50`,
      since,
    ),
    prisma.$queryRawUnsafe<Array<{ apiTokenId: string; count: number }>>(
      `SELECT api_token_id AS apiTokenId, COUNT(*) AS count
       FROM doc_analytics_events
       WHERE event = 'page_view' AND created_at >= ?
       GROUP BY api_token_id
       ORDER BY count DESC
       LIMIT 30`,
      since,
    ),
    prisma.$queryRawUnsafe<Array<{ apiTokenId: string; count: number }>>(
      `SELECT api_token_id AS apiTokenId, COUNT(*) AS count
       FROM doc_analytics_events
       WHERE event = 'ask_ai' AND created_at >= ?
       GROUP BY api_token_id
       ORDER BY count DESC
       LIMIT 30`,
      since,
    ),
    prisma.$queryRawUnsafe<Array<{ docPath: string }>>(
      `SELECT DISTINCT doc_path AS docPath
       FROM doc_analytics_events
       WHERE event = 'page_view' AND created_at >= ?`,
      coldSince,
    ),
  ]);

  const tokens = await prisma.apiToken.findMany({
    select: { id: true, personName: true, personCode: true, label: true },
  });
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  const personLabel = (tokenId: string) => {
    const t = tokenMap.get(tokenId);
    return t?.personName?.trim() || t?.personCode?.trim() || tokenId;
  };

  const viewedSet = new Set(viewedCold.map((x) => normalizeDocPath(x.docPath)));
  const coldDocs = listMigrationMarkdownDocuments()
    .filter((item) => !docPathMatchesRel(item.relPath, item.libraryId, viewedSet))
    .slice(0, 80)
    .map((item) => ({ relPath: `${item.libraryId}/${item.relPath}` }));

  const askMap = new Map(personAskAi.map((x) => [x.apiTokenId, Number(x.count) || 0]));

  return {
    days,
    migrationDocCount: countMigrationDocs(),
    hotDocs: mergeHotDocsByPath(hotDocs),
    coldDocs,
    personStats: personViews.map((x) => ({
      person: personLabel(x.apiTokenId),
      pageViews: Number(x.count) || 0,
      askAi: askMap.get(x.apiTokenId) || 0,
    })),
  };
}
