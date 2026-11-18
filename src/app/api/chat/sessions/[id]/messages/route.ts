import { appendMessageToSessionForToken, listMessagesBySessionForTokenPaged } from "@/lib/chat-store";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

const CHAT_ATTACHMENT_MAX_COUNT = 5;
const CHAT_ATTACHMENT_MAX_SIZE = 6 * 1024 * 1024;
const CHAT_ATTACHMENT_ROOT = "user-uploads";

function normalizeSlashes(raw: string) {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

function basenameOnly(raw: string) {
  const normalized = normalizeSlashes(String(raw || "").trim());
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function inferAttachmentMime(name: string, mime?: string | null) {
  const provided = String(mime || "").trim().toLowerCase();
  if (provided) return provided;
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function normalizeChatAttachments(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ path: string; name: string; mime: string; size: number; kind: "image" | "file" }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const pathValue = normalizeSlashes(String((item as { path?: unknown }).path || "").trim());
    const name = basenameOnly(String((item as { name?: unknown }).name || "").trim());
    const mime = inferAttachmentMime(name, String((item as { mime?: unknown }).mime || ""));
    const size = Number((item as { size?: unknown }).size || 0);
    if (!pathValue.startsWith(`${CHAT_ATTACHMENT_ROOT}/`) || pathValue.includes("..")) continue;
    if (!name || seen.has(pathValue)) continue;
    if (!Number.isFinite(size) || size < 0 || size > CHAT_ATTACHMENT_MAX_SIZE) continue;
    seen.add(pathValue);
    out.push({
      path: pathValue,
      name,
      mime,
      size,
      kind: mime.startsWith("image/") ? "image" : "file",
    });
    if (out.length >= CHAT_ATTACHMENT_MAX_COUNT) break;
  }
  return out;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const beforeCreatedAt = url.searchParams.get("beforeCreatedAt") || undefined;
  const beforeId = url.searchParams.get("beforeId") || undefined;
  const limit = Number(url.searchParams.get("limit") || 30);
  const page = await listMessagesBySessionForTokenPaged({
    sessionId: id,
    tokenId: tok.id,
    beforeCreatedAt,
    beforeId,
    limit,
  });
  if (!page) return new Response("Not found", { status: 404 });
  return Response.json({
    items: page.items,
    pageInfo: {
      hasMore: page.hasMore,
    },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    role?: "user" | "assistant";
    content?: string;
    metadata?: Record<string, unknown> | null;
  };
  const role = body.role === "assistant" ? "assistant" : "user";
  const content = String(body.content || "").trim();
  const metadata = body.metadata || null;
  const attachments = normalizeChatAttachments((metadata as { attachments?: unknown } | null)?.attachments);
  if (!content && !attachments.length) {
    return Response.json({ error: "content_required" }, { status: 400 });
  }
  const item = await appendMessageToSessionForToken({
    sessionId: id,
    tokenId: tok.id,
    role,
    content,
    metadata: metadata ? { ...metadata, attachments } : attachments.length ? { attachments } : null,
  });
  if (!item) return new Response("Not found", { status: 404 });
  return Response.json(item, { status: 201 });
}
