export const TIME_RANGES = [
  { id: "all", label: "全部" },
  { id: "7d", label: "近7天" },
  { id: "1m", label: "近1月" },
  { id: "3m", label: "近3月" },
  { id: "6m", label: "近半年" },
  { id: "ytd", label: "今年" },
] as const;

export type TimeRangeId = (typeof TIME_RANGES)[number]["id"];

export function isTimeRangeId(value: string): value is TimeRangeId {
  return TIME_RANGES.some((item) => item.id === value);
}

/** 按更新时间滚动回溯。今年从本地 1 月 1 日 0 点起。 */
export function timeRangeStart(range: TimeRangeId, now = new Date()): Date | null {
  if (range === "all") return null;
  if (range === "ytd") return new Date(now.getFullYear(), 0, 1);
  const start = new Date(now);
  if (range === "7d") start.setDate(start.getDate() - 7);
  else if (range === "1m") start.setMonth(start.getMonth() - 1);
  else if (range === "3m") start.setMonth(start.getMonth() - 3);
  else start.setMonth(start.getMonth() - 6);
  return start;
}
