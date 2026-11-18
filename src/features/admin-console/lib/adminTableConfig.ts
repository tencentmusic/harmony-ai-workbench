export const ADMIN_TABLE_PAGE_SIZE_KEY = "admin-table-page-size";

export const ADMIN_TABLE_DEFAULT_PAGE_SIZE = 12;

export const ADMIN_TABLE_PAGE_SIZE_OPTIONS = [12, 24, 48] as const;

export const ADMIN_TABLE_COMPACT_PAGE_SIZE_OPTIONS = [8, 12, 24] as const;

/** relations sync-check 摘要中文 */
export const RELATION_SYNC_STATUS_LABELS: Record<string, string> = {
  in_sync: "已同步",
  drift: "有差异",
  missing_in_db: "库中缺失",
  orphan_in_db: "库内多余",
  admin_protected: "Admin 保护",
  admin_conflict: "Admin 冲突",
};

export function formatRelationSyncSummary(summary: Record<string, number> | undefined) {
  if (!summary) return null;
  const adminTotal = (summary.admin_protected || 0) + (summary.admin_conflict || 0);
  return [
    `${RELATION_SYNC_STATUS_LABELS.in_sync} ${summary.in_sync || 0}`,
    `${RELATION_SYNC_STATUS_LABELS.drift} ${summary.drift || 0}`,
    `${RELATION_SYNC_STATUS_LABELS.missing_in_db} ${summary.missing_in_db || 0}`,
    `${RELATION_SYNC_STATUS_LABELS.orphan_in_db} ${summary.orphan_in_db || 0}`,
    `Admin ${adminTotal}`,
  ].join(" · ");
}

/** 根据每页条数估算表格 body 滚动高度（卡片内小表） */
export function adminTableScrollY(pageSize: number, rowHeight = 39, headerHeight = 40, max = 520) {
  return Math.min(max, Math.max(120, pageSize * rowHeight + headerHeight));
}

export function readStoredPageSize(fallback = ADMIN_TABLE_DEFAULT_PAGE_SIZE) {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(ADMIN_TABLE_PAGE_SIZE_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function storePageSize(size: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADMIN_TABLE_PAGE_SIZE_KEY, String(size));
}

const ADMIN_TABLE_COL_WIDTH_PREFIX = "admin-table-col-widths:";

export function readStoredColumnWidths(tableKey: string | undefined): Record<string, number> {
  if (!tableKey || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`${ADMIN_TABLE_COL_WIDTH_PREFIX}${tableKey}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function storeColumnWidths(tableKey: string, widths: Record<string, number>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${ADMIN_TABLE_COL_WIDTH_PREFIX}${tableKey}`, JSON.stringify(widths));
}
