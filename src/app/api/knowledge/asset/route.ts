import { readKnowledgeAsset } from "@/server/modules/knowledge/public";
import { knowledgeErrorResponse, requireKnowledgeToken } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = await requireKnowledgeToken(req);
  if (!token) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  try {
    const asset = readKnowledgeAsset({
      libraryId: url.searchParams.get("libraryId") || "",
      path: url.searchParams.get("path") || "",
      allowedScopeIds: token.appScopeIds,
    });
    const fileName = asset.path.split("/").at(-1) || "download";
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
