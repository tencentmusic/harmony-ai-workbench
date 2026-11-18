import { listKnowledgeCatalog } from "@/server/modules/knowledge/public";
import { knowledgeErrorResponse, requireKnowledgeToken } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = await requireKnowledgeToken(req);
  if (!token) return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ items: listKnowledgeCatalog(token.appScopeIds) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
