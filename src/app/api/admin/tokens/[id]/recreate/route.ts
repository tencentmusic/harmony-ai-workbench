import { prisma } from "@/lib/prisma";
import { hashToken, invalidateBearerVerifyCacheByTokenId, mintToken } from "@/lib/token";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const { id } = await ctx.params;

  const source = await prisma.apiToken.findUnique({
    where: { id },
    select: {
      id: true,
      personName: true,
      personCode: true,
      expiresAt: true,
    },
  });
  if (!source) return new Response("Not found", { status: 404 });

  const samePersonTokens = await prisma.apiToken.findMany({
    where: {
      personName: source.personName,
      personCode: source.personCode,
      id: { not: source.id },
    },
    select: { id: true },
  });
  const legacyTokenIds = samePersonTokens.map((token) => token.id);

  const raw = mintToken();
  const tokenHash = hashToken(raw);
  const updated = await prisma.apiToken.update({
    where: { id: source.id },
    data: {
      tokenHash,
      revokedAt: null,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });
  let migratedSessionCount = 0;
  if (legacyTokenIds.length) {
    const tableRows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions' LIMIT 1`
    );
    if (tableRows.length) {
      const placeholders = legacyTokenIds.map(() => "?").join(", ");
      const result = await prisma.$executeRawUnsafe(
        `UPDATE chat_sessions SET token_id = ? WHERE token_id IN (${placeholders})`,
        source.id,
        ...legacyTokenIds
      );
      migratedSessionCount = Number(result || 0);
    }
  }
  invalidateBearerVerifyCacheByTokenId(source.id);
  return Response.json({
    id: updated.id,
    token: raw,
    expiresAt: updated.expiresAt,
    personName: source.personName,
    personCode: source.personCode,
    migratedSessionCount,
  });
}

