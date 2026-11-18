"use client";

import { useCallback, useMemo, useState } from "react";
import type { TablePaginationConfig } from "antd";
import { ADMIN_TABLE_DEFAULT_PAGE_SIZE, ADMIN_TABLE_PAGE_SIZE_OPTIONS } from "../lib/adminTableConfig";
import { useAdminTablePageSize } from "../context/AdminTablePageSizeContext";

type Options = {
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  disabled?: boolean;
};

export function useAdminTablePagination(options: Options = {}) {
  const { pageSize: sharedPageSize, setPageSize, pageSizeOptions: sharedPageSizeOptions } = useAdminTablePageSize();
  const defaultPageSize = options.defaultPageSize ?? sharedPageSize ?? ADMIN_TABLE_DEFAULT_PAGE_SIZE;
  const pageSizeOptions = options.pageSizeOptions ?? [...sharedPageSizeOptions];
  const [current, setCurrent] = useState(1);

  const resetPage = useCallback(() => {
    setCurrent(1);
  }, []);

  const onPageChange = useCallback(
    (page: number, size?: number) => {
      setCurrent(page);
      if (typeof size === "number" && size > 0) setPageSize(size);
    },
    [setPageSize],
  );

  const onShowSizeChange = useCallback(
    (_page: number, size: number) => {
      setCurrent(1);
      if (typeof size === "number" && size > 0) setPageSize(size);
    },
    [setPageSize],
  );

  const pagination = useMemo<TablePaginationConfig | false>(() => {
    if (options.disabled) return false;
    return {
      current,
      pageSize: sharedPageSize || defaultPageSize,
      showSizeChanger: true,
      pageSizeOptions,
      showTotal: (total) => `共 ${total} 条`,
      onChange: onPageChange,
      onShowSizeChange,
    };
  }, [current, defaultPageSize, onPageChange, onShowSizeChange, options.disabled, pageSizeOptions, sharedPageSize]);

  return { pagination, resetPage, pageSize: sharedPageSize || defaultPageSize };
}
