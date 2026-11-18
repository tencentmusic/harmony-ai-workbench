import { KnowledgeAccessError } from "@/server/modules/knowledge/public";
import { verifyBearer } from "@/lib/token";

export async function requireKnowledgeToken(req: Request) {
  const token = await verifyBearer(req.headers.get("authorization"));
  if (!token) return null;
  return {
    id: token.id,
    appScopeIds: Array.isArray(token.appScopeIds) ? token.appScopeIds : [],
  };
}

export function knowledgeErrorResponse(error: unknown) {
  if (error instanceof KnowledgeAccessError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  console.error("knowledge_api_failed", error);
  return Response.json({ error: "knowledge_internal_error" }, { status: 500 });
}
