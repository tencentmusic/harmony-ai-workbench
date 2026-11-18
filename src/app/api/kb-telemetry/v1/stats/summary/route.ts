import { authorizeTelemetryRequest } from "@/lib/kb-telemetry-endpoints";
import { getKbTelemetrySummary } from "@/lib/kb-telemetry-query";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!authorizeTelemetryRequest(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 7)));

  try {
    const summary = await getKbTelemetrySummary(days);
    return Response.json(summary);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "query_failed",
        days,
      },
      { status: 500 },
    );
  }
}
