import { aggregateOpencodeUsage } from "@/lib/opencode-request-store";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

function readDateParam(value: string | null): Date | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t) : null;
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const url = new URL(req.url);
  const tokenId = (url.searchParams.get("tokenId") || "").trim();
  const startAt = readDateParam(url.searchParams.get("startAt"));
  const endAt = readDateParam(url.searchParams.get("endAt"));
  const sinceDaysRaw = Number(url.searchParams.get("sinceDays") || 0);
  const sinceDays = Number.isFinite(sinceDaysRaw) ? Math.max(0, Math.min(365, Math.floor(sinceDaysRaw))) : 0;
  const sinceAt = !startAt && sinceDays > 0 ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000) : null;
  const createdAtFilter = startAt || endAt ? { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lte: endAt } : {}) } : sinceAt ? { gte: sinceAt } : undefined;
  const tokenFilter = tokenId ? { apiTokenId: tokenId } : { apiTokenId: { not: null } };
  const tokens = await prisma.apiToken.findMany({
    where: tokenId ? { id: tokenId } : undefined,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      personName: true,
      personCode: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  const [jobs, opencodeRows] = await Promise.all([
    prisma.conversionJob.findMany({
      where: { ...tokenFilter, ...(createdAtFilter ? { createdAt: createdAtFilter } : {}) },
      select: { apiTokenId: true, status: true, createdAt: true },
    }),
    aggregateOpencodeUsage({
      tokenId: tokenId || undefined,
      startAt,
      endAt,
      sinceAt,
    }),
  ]);
  type Agg = { total: number; done: number; failed: number; running: number; pending: number; lastAt: string | null };
  const byToken = new Map<string, Agg>();
  for (const t of tokens) {
    byToken.set(t.id, { total: 0, done: 0, failed: 0, running: 0, pending: 0, lastAt: null });
  }
  const bump = (apiTokenId: string, status: string, createdAt: string | Date) => {
    const s = byToken.get(apiTokenId);
    if (!s) return;
    s.total++;
    if (status === "done") s.done++;
    else if (status === "failed") s.failed++;
    else if (status === "running") s.running++;
    else if (status === "pending") s.pending++;
    const createdIso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
    const cur = s.lastAt ? new Date(s.lastAt) : null;
    const next = new Date(createdIso);
    if (!cur || next > cur) s.lastAt = createdIso;
  };
  for (const j of jobs) {
    if (!j.apiTokenId) continue;
    bump(j.apiTokenId, j.status, j.createdAt);
  }
  for (const row of opencodeRows) {
    bump(row.apiTokenId, row.status, row.createdAt);
  }
  return Response.json({
    items: tokens.map((t) => ({
      ...t,
      stats: byToken.get(t.id)!,
    })),
  });
}
