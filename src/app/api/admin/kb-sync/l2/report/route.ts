import { recordSyncRun } from "@/lib/kb-sync/kb-sync-run";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

/** L2 health 报告上报（kb-sync l2 --check-only；Webhook 同源） */
export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const report = {
    domain: "l2_codegraph" as const,
    mode: "check" as const,
    ...body,
  };
  await recordSyncRun(
    {
      domain: "l2_codegraph",
      mode: "check",
      canonical_count: Number((body.summary as Record<string, number>)?.indexed || 0),
      db_count: 0,
      canonical_hash: String(body.checked_at || ""),
      db_catalog_hash: "",
      in_sync: !!body.healthy,
      summary: {
        in_sync: body.healthy ? 1 : 0,
        drift: Number((body.summary as Record<string, number>)?.stale || 0),
        missing_in_db: Number((body.summary as Record<string, number>)?.no_index || 0),
        orphan_in_db: 0,
        admin_protected: 0,
        admin_conflict: 0,
      },
      rows: [],
    },
    { operator: "l2-health-check", mode: "check" },
  );
  return Response.json({ ok: true, received: true });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const { prisma } = await import("@/lib/prisma");
  const last = await prisma.kbSyncRun.findFirst({ where: { domain: "l2_codegraph" }, orderBy: { createdAt: "desc" } });
  if (!last) return Response.json({ status: null });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(last.resultJson);
  } catch {
    parsed = {};
  }
  return Response.json({ status: parsed, last_run_at: last.createdAt.toISOString() });
}
