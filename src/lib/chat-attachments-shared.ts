export const CHAT_ATTACHMENT_MAX_COUNT = 5;
export const CHAT_ATTACHMENT_MAX_SIZE = 6 * 1024 * 1024;
export const CHAT_ATTACHMENT_ROOT = "user-uploads";

export type ChatAttachment = {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
};

function normalizeSlashes(raw: string) {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

function basenameOnly(raw: string) {
  const normalized = normalizeSlashes(String(raw || "").trim());
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function extensionFromName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function inferAttachmentMime(name: string, mime?: string | null) {
  const provided = String(mime || "").trim().toLowerCase();
  if (provided) return provided;
  const ext = extensionFromName(name);
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt" || ext === ".md") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

export function isAttachmentImageMime(mime?: string | null) {
  return String(mime || "").trim().toLowerCase().startsWith("image/");
}

export function normalizeChatAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const pathValue = normalizeSlashes(String((raw as { path?: unknown }).path || "").trim());
  const name = basenameOnly(String((raw as { name?: unknown }).name || "").trim());
  const mime = inferAttachmentMime(name, String((raw as { mime?: unknown }).mime || ""));
  const size = Number((raw as { size?: unknown }).size || 0);
  if (!pathValue.startsWith(`${CHAT_ATTACHMENT_ROOT}/`) || pathValue.includes("..")) return null;
  if (!name) return null;
  if (!Number.isFinite(size) || size < 0 || size > CHAT_ATTACHMENT_MAX_SIZE) return null;
  return {
    path: pathValue,
    name,
    mime,
    size,
    kind: isAttachmentImageMime(mime) ? "image" : "file",
  };
}

export function normalizeChatAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const normalized = normalizeChatAttachment(item);
    if (!normalized || seen.has(normalized.path)) continue;
    seen.add(normalized.path);
    out.push(normalized);
    if (out.length >= CHAT_ATTACHMENT_MAX_COUNT) break;
  }
  return out;
}
