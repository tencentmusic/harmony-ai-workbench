import { prisma } from "@/lib/prisma";
import { filterAllowedScopeIds, setTokenAppScopeIds } from "@/lib/token-app-scopes";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    revoked?: boolean;
    expiresInDays?: number | null;
    appScopeIds?: string[];
  };

  const data: { revokedAt?: Date | null; expiresAt?: Date | null } = {};
  if (typeof body.revoked === "boolean") data.revokedAt = body.revoked ? new Date() : null;
  if ("expiresInDays" in body) {
    if (body.expiresInDays === null) {
      data.expiresAt = null;
    } else if (typeof body.expiresInDays === "number" && body.expiresInDays > 0 && body.expiresInDays < 4000) {
      data.expiresAt = new Date(Date.now() + body.expiresInDays * 86400000);
    } else {
      return Response.json({ error: "expires_invalid" }, { status: 400 });
    }
  }
  if (Object.keys(data).length === 0 && !Array.isArray(body.appScopeIds)) return Response.json({ error: "empty_patch" }, { status: 400 });

  try {
    const row = Object.keys(data).length
      ? await prisma.apiToken.update({
          where: { id },
          data,
          select: {
            id: true,
            label: true,
            personName: true,
            personCode: true,
            revokedAt: true,
            expiresAt: true,
            createdAt: true,
          },
        })
      : await prisma.apiToken.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            label: true,
            personName: true,
            personCode: true,
            revokedAt: true,
            expiresAt: true,
            createdAt: true,
          },
        });
    if (Array.isArray(body.appScopeIds)) {
      const appScopeIds = filterAllowedScopeIds(body.appScopeIds);
      await setTokenAppScopeIds(id, appScopeIds);
      return Response.json({ ...row, appScopeIds });
    }
    return Response.json(row);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
