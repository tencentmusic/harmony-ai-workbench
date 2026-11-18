import { prisma } from "@/lib/prisma";
import { hashToken, mintToken } from "@/lib/token";
import { filterAllowedScopeIds, listTokenAppScopeMap, setTokenAppScopeIds } from "@/lib/token-app-scopes";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: "desc" } });
  const scopeMap = await listTokenAppScopeMap(rows.map((x) => x.id));
  return Response.json({
    items: rows.map((r) => ({
      id: r.id,
      label: r.label,
      personName: r.personName,
      personCode: r.personCode,
      revokedAt: r.revokedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      appScopeIds: scopeMap.get(r.id) || [],
    })),
  });
}

export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const body = (await req.json().catch(() => ({}))) as {
    label?: string;
    personName?: string;
    personCode?: string;
    expiresInDays?: number;
    appScopeIds?: string[];
  };
  const personName = typeof body.personName === "string" ? body.personName.trim() : "";
  const personCode = typeof body.personCode === "string" ? body.personCode.trim() : "";
  if (!personName || !personCode) {
    return Response.json({ error: "person_required" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : null;
  let expiresAt: Date | null = null;
  if (typeof body.expiresInDays === "number" && body.expiresInDays > 0 && body.expiresInDays < 4000) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 86400000);
  }
  const raw = mintToken();
  const tokenHash = hashToken(raw);
  const row = await prisma.apiToken.create({
    data: { label, personName, personCode, tokenHash, expiresAt },
  });
  let appScopeIds: string[] = [];
  if (Array.isArray(body.appScopeIds) && body.appScopeIds.length) {
    appScopeIds = await setTokenAppScopeIds(row.id, filterAllowedScopeIds(body.appScopeIds));
  }
  return Response.json({
    id: row.id,
    token: raw,
    expiresAt: row.expiresAt,
    personName,
    personCode,
    label: row.label,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    appScopeIds,
  });
}
