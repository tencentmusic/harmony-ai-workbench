import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });
  return Response.json({
    tokenId: tok.id,
    personName: tok.personName,
    personCode: tok.personCode,
    label: tok.label,
  });
}

