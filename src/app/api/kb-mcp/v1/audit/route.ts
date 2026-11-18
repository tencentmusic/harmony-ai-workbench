import { verifyBearer } from "@/lib/token";
import { parseKbMcpAuditSearchParams, queryKbMcpAudit } from "@/lib/kb-mcp-audit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const query = parseKbMcpAuditSearchParams(url);
  query.apiTokenId = tok.id;

  try {
    const result = await queryKbMcpAudit(query);
    return Response.json({
      ...result,
      scope: "self",
      token: {
        id: tok.id,
        personCode: tok.personCode,
        personName: tok.personName,
        label: tok.label,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "audit_query_failed" },
      { status: 500 },
    );
  }
}
