import { createSession, listSessionsByToken } from "@/lib/chat-store";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const items = await listSessionsByToken(tok.id);
  return Response.json({ items });
}

export async function POST(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const title = (body.title || "").trim() || "新会话";
  const item = await createSession(tok.id, title);
  return Response.json(item, { status: 201 });
}
