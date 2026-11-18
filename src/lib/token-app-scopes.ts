import { prisma } from "@/lib/prisma";
import { listAndroidAppScopes } from "@/lib/android-class-index";

function listConfigScopeIds() {
  return listAndroidAppScopes()
    .map((x) => String(x.id || "").trim())
    .filter((x) => x && x !== "all");
}

function normalizeScopeIds(scopeIds: string[]) {
  const allowSet = new Set(listConfigScopeIds());
  const dedup = new Set<string>();
  for (const raw of scopeIds) {
    const id = String(raw || "").trim();
    if (!id || id === "all" || !allowSet.has(id)) continue;
    dedup.add(id);
  }
  return [...dedup].sort();
}

export async function listTokenAppScopeIds(tokenId: string) {
  const rows = await prisma.apiTokenAppScope.findMany({
    where: { tokenId },
    orderBy: { appScopeId: "asc" },
    select: { appScopeId: true },
  });
  return normalizeScopeIds(rows.map((x) => x.appScopeId));
}

export async function setTokenAppScopeIds(tokenId: string, scopeIds: string[]) {
  const normalized = normalizeScopeIds(scopeIds);
  await prisma.$transaction([
    prisma.apiTokenAppScope.deleteMany({ where: { tokenId } }),
    ...(normalized.length
      ? [
          prisma.apiTokenAppScope.createMany({
            data: normalized.map((appScopeId) => ({ tokenId, appScopeId })),
          }),
        ]
      : []),
  ]);
  return normalized;
}

export async function listTokenAppScopeMap(tokenIds: string[]) {
  const ids = tokenIds.map((x) => String(x || "").trim()).filter(Boolean);
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await prisma.apiTokenAppScope.findMany({
    where: { tokenId: { in: ids } },
    orderBy: [{ tokenId: "asc" }, { appScopeId: "asc" }],
    select: { tokenId: true, appScopeId: true },
  });
  for (const row of rows) {
    const prev = out.get(row.tokenId) || [];
    if (!prev.includes(row.appScopeId)) prev.push(row.appScopeId);
    out.set(row.tokenId, prev);
  }
  return out;
}

export function filterAllowedScopeIds(scopeIds: string[]) {
  return normalizeScopeIds(scopeIds);
}
