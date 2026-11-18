import { listAndroidAppScopes } from "@/lib/android-class-index";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  const all = listAndroidAppScopes();
  const allowed = Array.isArray(tok.appScopeIds) ? tok.appScopeIds : [];
  if (!allowed.length) return Response.json({ items: all });
  const allowSet = new Set(allowed);
  return Response.json({ items: all.filter((x) => x.id === "all" || allowSet.has(x.id)) });
}
