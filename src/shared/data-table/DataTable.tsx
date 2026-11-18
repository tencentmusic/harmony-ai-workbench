"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Table } from "antd";
import type { TableProps } from "antd";
import type { ColumnType, ColumnsType } from "antd/es/table";
import styles from "./DataTable.module.css";
import { useResizableColumns } from "./useResizableColumns";

type Props<T extends object> = TableProps<T> & {
  /** 记住列宽。同一页面多张表要各自不同。 */
  tableKey: string;
};

let cachedScrollbarGutter: number | undefined;

function scrollbarGutter() {
  if (cachedScrollbarGutter !== undefined) return cachedScrollbarGutter;
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;";
  document.body.appendChild(probe);
  cachedScrollbarGutter = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return cachedScrollbarGutter;
}

function compareValues(left: unknown, right: unknown) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftTime = typeof left === "string" ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === "string" ? Date.parse(right) : Number.NaN;
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && /[-T:]/.test(String(left))) {
    return leftTime - rightTime;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), "zh");
}

function withDefaultSorters<T extends object>(columns: ColumnsType<T> | undefined): ColumnsType<T> {
  return (columns ?? []).map((col) => {
    if ("children" in col && col.children) {
      return { ...col, children: withDefaultSorters(col.children) };
    }
    const column = col as ColumnType<T>;
    if (column.sorter !== undefined) return column;
    const dataIndex = column.dataIndex;
    if (typeof dataIndex !== "string" && typeof dataIndex !== "number") return column;
    const field = String(dataIndex);
    return {
      ...column,
      sorter: (left: T, right: T) =>
        compareValues(
          (left as Record<string, unknown>)[field],
          (right as Record<string, unknown>)[field],
        ),
    };
  });
}

export function DataTable<T extends object>({
  columns,
  scroll,
  tableKey,
  ...rest
}: Props<T>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const sortableColumns = useMemo(() => withDefaultSorters(columns), [columns]);
  const fillWidth = scroll?.x == null;

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const update = () => setContainerWidth(Math.max(0, Math.floor(element.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fillTarget = Math.max(0, containerWidth - (scroll?.y != null ? scrollbarGutter() : 0));
  const { columns: mergedColumns, components, totalWidth } = useResizableColumns(sortableColumns, {
    tableKey,
    containerWidth: fillWidth ? fillTarget : containerWidth,
    fillWidth,
    enabled: true,
  });

  const resolvedScroll = useMemo(() => {
    const wider = containerWidth > 0 && totalWidth > containerWidth + 2;
    if (!scroll && !wider) return undefined;
    const next: NonNullable<TableProps<T>["scroll"]> = { ...scroll };
    if (wider) next.x = totalWidth;
    else delete next.x;
    return next;
  }, [containerWidth, scroll, totalWidth]);

  return (
    <div ref={wrapRef} className={`${styles.wrap} data-table-wrap`}>
      <Table<T>
        tableLayout="fixed"
        showSorterTooltip={{ title: "点击排序" }}
        {...rest}
        columns={mergedColumns}
        components={components}
        scroll={resolvedScroll}
      />
    </div>
  );
}
