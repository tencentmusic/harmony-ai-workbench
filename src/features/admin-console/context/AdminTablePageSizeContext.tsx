"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ADMIN_TABLE_DEFAULT_PAGE_SIZE,
  ADMIN_TABLE_PAGE_SIZE_OPTIONS,
  readStoredPageSize,
  storePageSize,
} from "../lib/adminTableConfig";

type AdminTablePageSizeContextValue = {
  pageSize: number;
  setPageSize: (size: number) => void;
  pageSizeOptions: readonly number[];
};

const AdminTablePageSizeContext = createContext<AdminTablePageSizeContextValue | null>(null);

export function AdminTablePageSizeProvider({ children }: { children: ReactNode }) {
  const [pageSize, setPageSizeState] = useState(() => readStoredPageSize());

  const setPageSize = useCallback((size: number) => {
    if (!Number.isFinite(size) || size <= 0) return;
    setPageSizeState(size);
    storePageSize(size);
  }, []);

  const value = useMemo(
    () => ({
      pageSize,
      setPageSize,
      pageSizeOptions: ADMIN_TABLE_PAGE_SIZE_OPTIONS,
    }),
    [pageSize, setPageSize],
  );

  return <AdminTablePageSizeContext.Provider value={value}>{children}</AdminTablePageSizeContext.Provider>;
}

export function useAdminTablePageSize() {
  const ctx = useContext(AdminTablePageSizeContext);
  if (!ctx) {
    return {
      pageSize: ADMIN_TABLE_DEFAULT_PAGE_SIZE,
      setPageSize: (_size: number) => {},
      pageSizeOptions: ADMIN_TABLE_PAGE_SIZE_OPTIONS,
    };
  }
  return ctx;
}
