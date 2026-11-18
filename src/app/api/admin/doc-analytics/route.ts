import { getDocAnalyticsSummary } from "@/lib/doc-analytics-store";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 7)));
  const summary = await getDocAnalyticsSummary(days);
  return Response.json(summary);
}
