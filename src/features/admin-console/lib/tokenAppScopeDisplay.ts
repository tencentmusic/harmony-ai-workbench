export function resolveTokenAppScopeIds(ids: string[] | undefined, catalogIds: string[]) {
  const raw = (Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!catalogIds.length) return raw;
  return raw.filter((id) => catalogIds.includes(id));
}
