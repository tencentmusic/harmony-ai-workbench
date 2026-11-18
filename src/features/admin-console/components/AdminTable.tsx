"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Table } from "antd";
import type { TableProps } from "antd";
import { useAdminTablePagination } from "../hooks/useAdminTablePagination";
import { useResizableColumns } from "../hooks/useResizableColumns";
import { adminTableScrollY } from "../lib/adminTableConfig";

type Preset = "default" | "compact" | "none";

type Props<T> = Omit<TableProps<T>, "pagination"> & {
  paginationPreset?: Preset;
  pagination?: TableProps<T>["pagination"] | false;
  autoScrollY?: boolean;
  /** 用于持久化列宽；未传时仍可调宽，但不写入 localStorage */
  tableKey?: string;
  resizable?: boolean;
};

const SORTER_TOOLTIP = { title: "点击排序" };

export function AdminTable<T extends object>({
  paginationPreset = "default",
  pagination: paginationOverride,
  autoScrollY = false,
  scroll,
  columns,
  tableKey,
  resizable = true,
  ...rest
}: Props<T>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const { pagination: sharedPagination, pageSize } = useAdminTablePagination({
    disabled: paginationPreset === "none" || paginationOverride === false,
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const update = () => {
      setContainerWidth(Math.max(0, Math.floor(el.clientWidth)));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fillWidth = scroll?.x == null;
  const { columns: mergedColumns, components, totalWidth } = useResizableColumns(columns, {
    tableKey,
    containerWidth,
    fillWidth,
    enabled: resizable,
  });

  const resolvedPagination = useMemo<TableProps<T>["pagination"]>(() => {
    if (paginationPreset === "none" || paginationOverride === false) return false;
    if (paginationOverride && typeof paginationOverride === "object") {
      return { ...(sharedPagination as object), ...paginationOverride };
    }
    return sharedPagination;
  }, [paginationOverride, paginationPreset, sharedPagination]);

  const resolvedScroll = useMemo(() => {
    const base = scroll ?? (autoScrollY ? { y: adminTableScrollY(pageSize) } : undefined);
    if (!resizable) return base;

    const scrollX =
      scroll?.x != null
        ? scroll.x
        : fillWidth && containerWidth > 0
          ? Math.max(containerWidth, totalWidth)
          : totalWidth > 0
            ? totalWidth
            : undefined;

    if (scrollX == null && base == null) return undefined;
    return { ...base, x: scrollX };
  }, [autoScrollY, containerWidth, fillWidth, pageSize, resizable, scroll, totalWidth]);

  return (
    <div ref={wrapRef} className="admin-table-wrap">
      <Table<T>
        showSorterTooltip={SORTER_TOOLTIP}
        tableLayout="fixed"
        {...rest}
        columns={mergedColumns}
        components={components}
        scroll={resolvedScroll}
        pagination={resolvedPagination}
      />
    </div>
  );
}
