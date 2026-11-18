import { parseOverviewChartRange, telemetryWindowFromRange, type OverviewChartRange } from "@/lib/admin-overview-range";
import { buildStatsSummary } from "@/lib/kb-telemetry-aggregates";
import { createTelemetryQueryClient } from "@/lib/kb-telemetry-store";

export async function getKbTelemetrySummary(days = 7) {
  const client = createTelemetryQueryClient();
  return buildStatsSummary(client, days);
}

export async function getKbTelemetrySummaryByRange(range: OverviewChartRange) {
  const client = createTelemetryQueryClient();
  const window = telemetryWindowFromRange(range);
  return buildStatsSummary(client, {
    since: window.since,
    until: window.until,
    range: window.range,
  });
}

export function parseKbTelemetryRange(raw: string | null | undefined): OverviewChartRange | null {
  if (!raw) return null;
  return parseOverviewChartRange(raw);
}
