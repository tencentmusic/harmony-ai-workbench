import { createFeedback } from "@/lib/feedback-store";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) return Response.json({ error: "content_required" }, { status: 400 });
  if (content.length > 200) return Response.json({ error: "content_too_long" }, { status: 400 });

  const result = await createFeedback({
    content,
    apiTokenId: tok.id,
    userAgent: req.headers.get("user-agent"),
  });
  return Response.json({ ok: true, id: result.id });
}
