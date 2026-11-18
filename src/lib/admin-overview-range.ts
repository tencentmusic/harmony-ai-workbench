export type OverviewChartRange = "last7d" | "thisMonth" | "lastMonth" | "all";

export const OVERVIEW_CHART_RANGE_LABEL: Record<OverviewChartRange, string> = {
  last7d: "近 7 天",
  thisMonth: "本月",
  lastMonth: "上月",
  all: "累计",
};

export function parseOverviewChartRange(raw: string | null | undefined): OverviewChartRange {
  if (raw === "thisMonth" || raw === "lastMonth" || raw === "all") return raw;
  return "last7d";
}

export type OverviewTimeWindow = {
  range: OverviewChartRange;
  label: string;
  start: Date | null;
  end: Date;
  lineBuckets: Array<{ key: string; start: Date; end: Date }>;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function formatDayLabel(d: Date) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function formatMonthLabel(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function resolveOverviewTimeWindow(range: OverviewChartRange, now = new Date()): OverviewTimeWindow {
  const label = OVERVIEW_CHART_RANGE_LABEL[range];
  const end = endOfDay(now);

  if (range === "all") {
    const lineBuckets: OverviewTimeWindow["lineBuckets"] = [];
    for (let i = 11; i >= 0; i -= 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() - i + 1, 0));
      lineBuckets.push({
        key: formatMonthLabel(monthStart),
        start: startOfDay(monthStart),
        end: monthEnd,
      });
    }
    return { range, label, start: null, end, lineBuckets };
  }

  let start: Date;
  let rangeEnd = end;

  if (range === "last7d") {
    start = startOfDay(now);
    start.setDate(start.getDate() - 6);
  } else if (range === "thisMonth") {
    start = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  } else {
    start = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    rangeEnd = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
  }

  const lineBuckets: OverviewTimeWindow["lineBuckets"] = [];
  const cursor = startOfDay(start);
  const lastDay = startOfDay(rangeEnd);
  while (cursor.getTime() <= lastDay.getTime()) {
    const dayStart = startOfDay(cursor);
    const dayEnd = endOfDay(cursor);
    lineBuckets.push({ key: formatDayLabel(cursor), start: dayStart, end: dayEnd });
    cursor.setDate(cursor.getDate() + 1);
  }

  return { range, label, start, end: rangeEnd, lineBuckets };
}

export function eventInBucket(createdAt: string | Date, bucket: { start: Date; end: Date }) {
  const t = new Date(createdAt).getTime();
  return t >= bucket.start.getTime() && t <= bucket.end.getTime();
}

export function eventInWindow(createdAt: string | Date, start: Date | null, end: Date) {
  const t = new Date(createdAt).getTime();
  if (start && t < start.getTime()) return false;
  return t <= end.getTime();
}

export function telemetryWindowFromRange(range: OverviewChartRange, now = new Date()) {
  const window = resolveOverviewTimeWindow(range, now);
  return {
    range,
    label: window.label,
    since: (window.start ?? new Date(0)).toISOString(),
    until: range === "lastMonth" ? window.end.toISOString() : undefined,
  };
}
