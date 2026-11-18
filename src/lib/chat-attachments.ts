import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { getAgentWorkspaceCwd } from "@/lib/agent-backend/resolve-backend";
import {
  CHAT_ATTACHMENT_ROOT,
  inferAttachmentMime,
  isAttachmentImageMime,
  type ChatAttachment,
} from "@/lib/chat-attachments-shared";

function normalizeSlashes(raw: string) {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

function sanitizeFilename(raw: string) {
  const base = String(raw || "").trim().replace(/^.*[\\/]/, "") || "attachment";
  return base.replace(/[^\w.\-()+@\u4e00-\u9fa5]+/g, "_").slice(-120) || "attachment";
}

export async function saveChatAttachment(opts: {
  tokenId: string;
  name: string;
  mime?: string | null;
  bytes: Uint8Array;
}): Promise<ChatAttachment> {
  const safeName = sanitizeFilename(opts.name);
  const mime = inferAttachmentMime(safeName, opts.mime);
  const relDir = `${CHAT_ATTACHMENT_ROOT}/${opts.tokenId}`;
  const relPath = `${relDir}/${crypto.randomUUID()}-${safeName}`;
  const workspaceRoot = path.resolve(getAgentWorkspaceCwd());
  const absDir = path.join(workspaceRoot, relDir);
  const absPath = path.join(workspaceRoot, relPath);
  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(absPath, opts.bytes);
  return {
    path: normalizeSlashes(relPath),
    name: safeName,
    mime,
    size: opts.bytes.byteLength,
    kind: isAttachmentImageMime(mime) ? "image" : "file",
  };
}
