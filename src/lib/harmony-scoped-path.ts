/** 与 android-app-scopes.SCOPE_PATH_SEP 保持一致，本文件无 @/ 依赖以便 node 单测直接 import */
export const HARMONY_SCOPE_PATH_SEP = "::";
export const HARMONY_SCOPE_PATH_MARKER = "harmony::";

export function encodeHarmonyScopedRelativePath(scopeId: string, repoRelativePath: string, symbol?: string) {
  const rel = repoRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = `${HARMONY_SCOPE_PATH_MARKER}${scopeId}${HARMONY_SCOPE_PATH_SEP}${rel}`;
  const sym = String(symbol || "").trim();
  return sym ? `${base}#${sym}` : base;
}

export function decodeHarmonyScopedRelativePath(relativePath: string) {
  let rel = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const hashIdx = rel.indexOf("#");
  if (hashIdx >= 0) rel = rel.slice(0, hashIdx);
  if (!rel.startsWith(HARMONY_SCOPE_PATH_MARKER)) return null;
  const rest = rel.slice(HARMONY_SCOPE_PATH_MARKER.length);
  const idx = rest.indexOf(HARMONY_SCOPE_PATH_SEP);
  if (idx <= 0) return null;
  return {
    scopeId: rest.slice(0, idx),
    repoRelativePath: rest.slice(idx + HARMONY_SCOPE_PATH_SEP.length),
  };
}

export function buildHarmonySyntheticFqn(scopeId: string, symbol: string) {
  return `harmony.${scopeId}.${symbol}`;
}
