"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import type { TableProps } from "antd";
import type { ColumnType, ColumnsType } from "antd/es/table";
import type { ResizeCallbackData } from "react-resizable";
import { ResizableTableTitle } from "./ResizableTableTitle";

const MIN_COL_WIDTH = 56;
const WIDTH_PREFIX = "workbench-table-col-widths:";

function readStoredColumnWidths(tableKey: string | undefined): Record<string, number> {
  if (!tableKey || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`${WIDTH_PREFIX}${tableKey}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function storeColumnWidths(tableKey: string, widths: Record<string, number>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${WIDTH_PREFIX}${tableKey}`, JSON.stringify(widths));
}

function getColumnKey<T>(col: ColumnType<T>, index: number): string {
  if (col.key != null) return String(col.key);
  const dataIndex = col.dataIndex;
  if (dataIndex != null) {
    return Array.isArray(dataIndex) ? dataIndex.join(".") : String(dataIndex);
  }
  if (typeof col.title === "string") return col.title;
  return `col-${index}`;
}

function readDeclaredWidth<T>(col: ColumnType<T>): number {
  return typeof col.width === "number" && col.width > 0 ? col.width : 0;
}

function balanceWidths(keys: string[], widths: Record<string, number>, targetTotal: number) {
  const next = { ...widths };
  let total = keys.reduce((sum, key) => sum + (next[key] || MIN_COL_WIDTH), 0);
  if (targetTotal <= 0 || total === targetTotal) return next;

  if (total < targetTotal) {
    let guard = 0;
    while (total < targetTotal && guard < targetTotal * 2) {
      const key = keys[guard % keys.length];
      next[key] = (next[key] || MIN_COL_WIDTH) + 1;
      total += 1;
      guard += 1;
    }
    return next;
  }

  const scale = targetTotal / total;
  keys.forEach((key) => {
    next[key] = Math.max(MIN_COL_WIDTH, Math.floor((next[key] || MIN_COL_WIDTH) * scale));
  });
  return balanceWidths(keys, next, targetTotal);
}

function buildInitialWidths<T>(
  columns: ColumnsType<T>,
  containerWidth: number,
  stored: Record<string, number>,
): Record<string, number> {
  const keys = columns.map((col, index) => getColumnKey(col as ColumnType<T>, index));
  const declared = columns.map((col) => readDeclaredWidth(col as ColumnType<T>));
  const hasStored = keys.some((key) => stored[key] >= MIN_COL_WIDTH);
  const draft: Record<string, number> = {};
  keys.forEach((key, index) => {
    draft[key] = Math.max(MIN_COL_WIDTH, stored[key] || declared[index] || 120);
  });

  if (containerWidth <= 0) return draft;
  if (hasStored) return balanceWidths(keys, draft, containerWidth);

  const declaredTotal = declared.reduce((sum, width) => sum + width, 0);
  if (declaredTotal > 0) {
    const scale = containerWidth / declaredTotal;
    keys.forEach((key, index) => {
      draft[key] = Math.max(MIN_COL_WIDTH, Math.floor((declared[index] || 120) * scale));
    });
    return balanceWidths(keys, draft, containerWidth);
  }

  const even = Math.max(MIN_COL_WIDTH, Math.floor(containerWidth / keys.length));
  keys.forEach((key) => {
    draft[key] = even;
  });
  return balanceWidths(keys, draft, containerWidth);
}

type Options = {
  tableKey?: string;
  containerWidth: number;
  fillWidth: boolean;
  enabled: boolean;
};

export function useResizableColumns<T extends object>(
  columns: ColumnsType<T> | undefined,
  { tableKey, containerWidth, fillWidth, enabled }: Options,
) {
  const columnList = columns ?? [];
  const keys = useMemo(
    () => columnList.map((col, index) => getColumnKey(col as ColumnType<T>, index)),
    [columnList],
  );
  const keysSignature = keys.join("\u0001");
  const [widths, setWidths] = useState<Record<string, number>>({});
  const initializedRef = useRef(false);
  const userAdjustedRef = useRef(false);
  const lastContainerRef = useRef(0);

  useEffect(() => {
    initializedRef.current = false;
    userAdjustedRef.current = false;
    lastContainerRef.current = 0;
  }, [keysSignature, tableKey]);

  useEffect(() => {
    if (!enabled || !columnList.length) return;
    const stored = readStoredColumnWidths(tableKey);
    const hasStored = Object.keys(stored).some((key) => stored[key] >= MIN_COL_WIDTH);
    const containerChanged =
      fillWidth && containerWidth > 0 && Math.abs(containerWidth - lastContainerRef.current) > 24;

    if (initializedRef.current) {
      if (userAdjustedRef.current || !containerChanged) return;
      if (hasStored && !fillWidth) return;
    }

    const next = buildInitialWidths(columnList, fillWidth ? containerWidth : 0, stored);
    initializedRef.current = true;
    lastContainerRef.current = containerWidth;
    setWidths(next);
  }, [columnList, containerWidth, enabled, fillWidth, keysSignature, tableKey]);

  const persistWidths = useCallback(
    (next: Record<string, number>) => {
      if (tableKey) storeColumnWidths(tableKey, next);
    },
    [tableKey],
  );

  const handleResize = useCallback(
    (key: string) => (_event: SyntheticEvent, { size }: ResizeCallbackData) => {
      userAdjustedRef.current = true;
      setWidths((prev) => {
        const next = { ...prev, [key]: Math.max(MIN_COL_WIDTH, Math.floor(size.width)) };
        persistWidths(next);
        return next;
      });
    },
    [persistWidths],
  );

  const mergedColumns = useMemo(() => {
    if (!enabled) return columnList;
    return columnList.map((col, index) => {
      const key = keys[index];
      const width = widths[key] || readDeclaredWidth(col as ColumnType<T>) || 120;
      const prevOnHeaderCell = (col as ColumnType<T>).onHeaderCell;
      return {
        ...col,
        width,
        onHeaderCell: (column: unknown) => {
          const typedColumn = column as ColumnType<T>;
          const prev =
            typeof prevOnHeaderCell === "function"
              ? (prevOnHeaderCell as (col: unknown) => Record<string, unknown> | undefined)(column)
              : prevOnHeaderCell;
          return {
            ...prev,
            width: typedColumn.width as number,
            onResize: handleResize(key),
          };
        },
      } as ColumnType<T>;
    });
  }, [columnList, enabled, handleResize, keys, widths]);

  const components = useMemo<TableProps<T>["components"]>(
    () =>
      enabled
        ? {
            header: {
              cell: ResizableTableTitle,
            },
          }
        : undefined,
    [enabled],
  );

  const totalWidth = useMemo(
    () => keys.reduce((sum, key) => sum + (widths[key] || MIN_COL_WIDTH), 0),
    [keys, widths],
  );

  return { columns: mergedColumns, components, totalWidth };
}
