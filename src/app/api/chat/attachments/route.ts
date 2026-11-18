import { NextRequest } from "next/server";

import {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_SIZE,
} from "@/lib/chat-attachments-shared";
import {
  saveChatAttachment,
} from "@/lib/chat-attachments";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return jsonError("unauthorized", 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("invalid_form_data", 400);
  }

  const files = form
    .getAll("files")
    .filter((item): item is File => typeof File !== "undefined" && item instanceof File);

  if (!files.length) return jsonError("files_required", 400);
  if (files.length > CHAT_ATTACHMENT_MAX_COUNT) {
    return jsonError("too_many_attachments", 400);
  }

  const items = [];
  for (const file of files) {
    if (file.size > CHAT_ATTACHMENT_MAX_SIZE) {
      return jsonError("attachment_too_large", 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    items.push(
      await saveChatAttachment({
        tokenId: tok.id,
        name: file.name,
        mime: file.type,
        bytes,
      }),
    );
  }

  return Response.json({ items }, { status: 201 });
}
