import {
  getAndroidAppScopeById,
  getAndroidAppScopeWorkspaceAlias,
  parseAndroidAppScopes,
  resolveAndroidAppScopeRepoRoot,
} from "@/lib/android-app-scopes";
import {
  listKbProjectIdsFromScopeIds,
  resolveAndroidWorkspaceAliasForKbProject,
  resolveKbProjectIdFromAppScope,
} from "@/lib/kb-project-labels";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

function resolveEffectiveScopeIds(appScopeIds: string[]) {
  const all = parseAndroidAppScopes();
  const allowed = appScopeIds.map((x) => String(x || "").trim()).filter(Boolean);
  if (!allowed.length || allowed.includes("all")) {
    return all.map((s) => s.id);
  }
  const known = new Set(all.map((s) => s.id));
  return allowed.filter((id) => known.has(id));
}

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  const rawScopeIds = Array.isArray(tok.appScopeIds) ? tok.appScopeIds : [];
  const effectiveScopeIds = resolveEffectiveScopeIds(rawScopeIds);

  const scopes = effectiveScopeIds.map((id) => {
    const scope = getAndroidAppScopeById(id);
    if (!scope) return null;
    const kbProjectId = resolveKbProjectIdFromAppScope(id);
    const workspaceAlias =
      getAndroidAppScopeWorkspaceAlias(id) || resolveAndroidWorkspaceAliasForKbProject(kbProjectId);
    let repoRootAvailable = false;
    let repoRoot = "";
    try {
      repoRoot = resolveAndroidAppScopeRepoRoot(scope);
      repoRootAvailable = true;
    } catch {
      repoRootAvailable = false;
    }
    return {
      id: scope.id,
      label: scope.label,
      prefixes: scope.matchAll ? ["."] : scope.prefixes,
      matchAll: !!scope.matchAll,
      workspaceAlias,
      kbProjectId,
      repositoryId: scope.repositoryId,
      repoRoot,
      repoRootAvailable,
    };
  }).filter(Boolean);

  return Response.json({
    tokenId: tok.id,
    personCode: tok.personCode,
    personName: tok.personName,
    label: tok.label,
    appScopeIds: rawScopeIds.length ? rawScopeIds : ["all"],
    effectiveScopeIds,
    allowedKbProjectIds: listKbProjectIdsFromScopeIds(effectiveScopeIds),
    androidOnly: true,
    scopes,
  });
}
