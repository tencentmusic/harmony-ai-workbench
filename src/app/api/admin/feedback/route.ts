import { listFeedback } from "@/lib/feedback-store";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") || 200);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200));
  const rows = await listFeedback(limit);
  return Response.json({
    items: rows.map((row) => ({
      id: row.id,
      content: row.content,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      token: row.apiTokenId
        ? {
            id: row.apiTokenId,
            personName: row.personName || "",
            personCode: row.personCode || "",
            label: row.label,
          }
        : null,
    })),
  });
}
