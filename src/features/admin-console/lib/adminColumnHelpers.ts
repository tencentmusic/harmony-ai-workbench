import type { ReactNode } from "react";
import type { ColumnType } from "antd/es/table";

const ZH = "zh-CN";

function cellStr(v: unknown) {
  if (v == null) return "";
  return String(v);
}

function cellNum(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function sortStr<T>(key: keyof T & string, title: ReactNode, extra: Partial<ColumnType<T>> = {}): ColumnType<T> {
  return {
    title,
    dataIndex: key,
    sorter: (a, b) => cellStr(a[key]).localeCompare(cellStr(b[key]), ZH),
    ...extra,
  };
}

export function sortNum<T>(key: keyof T & string, title: ReactNode, extra: Partial<ColumnType<T>> = {}): ColumnType<T> {
  return {
    title,
    dataIndex: key,
    sorter: (a, b) => cellNum(a[key]) - cellNum(b[key]),
    ...extra,
  };
}

export function sortDate<T>(
  getValue: (row: T) => string | number | Date | null | undefined,
  title: ReactNode,
  extra: Partial<ColumnType<T>> = {},
): ColumnType<T> {
  const toMs = (v: string | number | Date | null | undefined) => {
    if (v == null) return 0;
    const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(ms) ? ms : 0;
  };
  return {
    title,
    sorter: (a, b) => toMs(getValue(a)) - toMs(getValue(b)),
    ...extra,
  };
}

export function withSorter<T>(col: ColumnType<T>, compare: (a: T, b: T) => number): ColumnType<T> {
  return { ...col, sorter: compare };
}
