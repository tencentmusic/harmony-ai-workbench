import { getKbTelemetrySummary, getKbTelemetrySummaryByRange, parseKbTelemetryRange } from "@/lib/kb-telemetry-query";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const url = new URL(req.url);
  const range = url.searchParams.get("range") ? parseKbTelemetryRange(url.searchParams.get("range")) : null;
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 7)));

  try {
    const summary = range ? await getKbTelemetrySummaryByRange(range) : await getKbTelemetrySummary(days);
    return Response.json(summary);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "telemetry_query_failed",
        days,
        hint: "在工台目录执行 npm run db:push，确认 prisma/data.db 已有 kb_telemetry_events 表",
      },
      { status: 503 },
    );
  }
}
