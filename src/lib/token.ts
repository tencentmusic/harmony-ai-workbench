import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { listTokenAppScopeIds } from "@/lib/token-app-scopes";

const VERIFY_CACHE_TTL_MS = 60_000;
type ApiTokenRow = NonNullable<Awaited<ReturnType<typeof prisma.apiToken.findFirst>>>;
type VerifiedBearer = (ApiTokenRow & { appScopeIds: string[] }) | null;
const verifyCache = new Map<string, { expiresAt: number; value: VerifiedBearer }>();

export function hashToken(raw: string): string {
  const pepper = process.env.TOKEN_PEPPER || "";
  return crypto.createHash("sha256").update(pepper + raw, "utf8").digest("hex");
}

export function mintToken(): string {
  return `hm_${crypto.randomBytes(24).toString("hex")}`;
}

export function invalidateBearerVerifyCacheByTokenId(tokenId: string) {
  for (const [raw, entry] of verifyCache.entries()) {
    if (entry.value && entry.value.id === tokenId) {
      verifyCache.delete(raw);
    }
  }
}

export async function verifyBearer(authorization: string | null): Promise<VerifiedBearer> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const raw = authorization.slice(7).trim();
  if (!raw) return null;
  const cacheHit = verifyCache.get(raw);
  if (cacheHit && cacheHit.expiresAt > Date.now()) return cacheHit.value;
  const tokenHash = hashToken(raw);
  const row = await prisma.apiToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (!row) {
    verifyCache.set(raw, { expiresAt: Date.now() + 10_000, value: null });
    return null;
  }
  const appScopeIds = await listTokenAppScopeIds(row.id).catch(() => []);
  const token = { ...row, appScopeIds };
  verifyCache.set(raw, { expiresAt: Date.now() + VERIFY_CACHE_TTL_MS, value: token });
  return token;
}
