import { getSessionByIdForToken, renameSessionForToken } from "@/lib/chat-store";
import { generateSessionTitleByAgent } from "@/lib/agent-backend/session-title";
import {
  buildSessionTitleFromBody,
  buildSessionTitleFromPrompt,
  shouldAutoRenameSession,
  summarizePromptForSessionTitle,
} from "@/lib/session-title";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

type AutoTitleBody = {
  prompt?: string;
};

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  const session = await getSessionByIdForToken(id, tok.id);
  if (!session) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => ({}))) as AutoTitleBody;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return Response.json({ error: "prompt_required" }, { status: 400 });

  if (!shouldAutoRenameSession(session.title)) {
    return Response.json(session);
  }

  const titleDate = new Date(session.createdAt);
  let titleBody = "";
  try {
    titleBody = await generateSessionTitleByAgent(prompt);
  } catch {
    titleBody = summarizePromptForSessionTitle(prompt);
  }

  const title = titleBody ? buildSessionTitleFromBody(titleBody, titleDate) : buildSessionTitleFromPrompt(prompt, titleDate);

  const row = await renameSessionForToken(id, tok.id, title);
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
