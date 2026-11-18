import { getAndroidScopePrefixesByIds, searchAndroidClasses, searchAndroidClassesByPrefixes } from "@/lib/android-class-index";
import { toAndroidWorkspacePath } from "@/lib/android-workspace-path";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const limit = Number(url.searchParams.get("limit") || 20);
  const requestedScopeId = url.searchParams.get("appScopeId")?.trim() || "";
  const allowedScopeIds = Array.isArray(tok.appScopeIds) ? tok.appScopeIds : [];
  if (!q) return Response.json({ items: [] });

  try {
    const merged: Awaited<ReturnType<typeof searchAndroidClasses>> = [];
    const seen = new Set<string>();
    const pushRows = (rows: Awaited<ReturnType<typeof searchAndroidClasses>>) => {
      for (const row of rows) {
        const key = `${row.fqn}::${row.module}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
        if (merged.length >= limit) break;
      }
    };
    if (!allowedScopeIds.length) {
      pushRows(await searchAndroidClasses(q, limit, requestedScopeId));
    } else {
      if (!requestedScopeId || requestedScopeId === "all") {
        const scopePrefixes = getAndroidScopePrefixesByIds(allowedScopeIds);
        const rows = await searchAndroidClassesByPrefixes(q, limit, scopePrefixes, allowedScopeIds);
        pushRows(rows);
      } else {
        const targetScope = allowedScopeIds.includes(requestedScopeId) ? requestedScopeId : allowedScopeIds[0];
        pushRows(await searchAndroidClasses(q, limit, targetScope, allowedScopeIds));
      }
    }
    return Response.json({
      items: merged.map((x) => {
        const harmonyScope = x.fqn.startsWith("harmony.") ? x.fqn.split(".")[1] : undefined;
        return {
          className: x.className,
          fqn: x.fqn,
          module: x.module,
          filePath: toAndroidWorkspacePath(x.relativePath, harmonyScope),
          platform: x.relativePath.startsWith("harmony::") ? "harmony" : "android",
        };
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg || "search_failed" }, { status: 500 });
  }
}
