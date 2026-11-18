import { readKnowledgeDocument } from "@/server/modules/knowledge/public";
import { knowledgeErrorResponse, requireKnowledgeToken } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = await requireKnowledgeToken(req);
  if (!token) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  try {
    return Response.json(readKnowledgeDocument({
      libraryId: url.searchParams.get("libraryId") || "",
      path: url.searchParams.get("path") || "",
      allowedScopeIds: token.appScopeIds,
    }));
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
