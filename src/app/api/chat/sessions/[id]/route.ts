import { deleteSessionForToken, renameSessionForToken } from "@/lib/chat-store";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const ok = await deleteSessionForToken(id, tok.id);
  if (!ok) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const title = String(body.title || "").trim();
  if (!title) return Response.json({ error: "title_required" }, { status: 400 });
  const row = await renameSessionForToken(id, tok.id, title);
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
