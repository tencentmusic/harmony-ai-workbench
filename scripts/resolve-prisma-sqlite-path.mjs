import path from "node:path";

/** Prisma SQLite：DATABASE_URL 中 file: 相对路径相对 schema.prisma 所在目录（prisma/）解析 */
export function resolvePrismaSqlitePath(databaseUrl, projectRoot) {
  if (!databaseUrl?.startsWith("file:")) return "";
  const rel = databaseUrl.slice("file:".length);
  return path.resolve(projectRoot, "prisma", rel);
}
