"use client";

import { useCallback, useLayoutEffect, useState } from "react";

const STORAGE_KEY = "hm_admin_theme_mode";

export type AdminThemeMode = "dark" | "light";

function readModeFromStorage(): AdminThemeMode {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "light";
}

export function useAdminTheme() {
  const [mode, setMode] = useState<AdminThemeMode>(readModeFromStorage);

  useLayoutEffect(() => {
    setMode(readModeFromStorage());
  }, []);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-admin-theme", mode);
    document.body.classList.toggle("admin-theme-light", mode === "light");
    document.body.classList.toggle("admin-theme-dark", mode === "dark");
  }, [mode]);

  const toggleTheme = useCallback(() => {
    setMode((prev) => {
      const next: AdminThemeMode = prev === "dark" ? "light" : "dark";
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return {
    mode,
    isDark: mode === "dark",
    toggleTheme,
  };
}
