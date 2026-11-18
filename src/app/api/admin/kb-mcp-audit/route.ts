import { parseKbMcpAuditSearchParams, queryKbMcpAudit } from "@/lib/kb-mcp-audit";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();

  const url = new URL(req.url);
  const query = parseKbMcpAuditSearchParams(url);

  try {
    const result = await queryKbMcpAudit(query);
    return Response.json({ ...result, scope: "admin" });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "audit_query_failed",
        hint: "确认 prisma/data.db 存在 kb_telemetry_events 表",
      },
      { status: 500 },
    );
  }
}
