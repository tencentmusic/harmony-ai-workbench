import type { Metadata } from "next";
import { AntdStyleRegistry } from "@/app/antd-registry";
import Script from "next/script";
import "antd/dist/reset.css";
import "./globals.css";
import { AntdProvider } from "@/app/providers";

export const metadata: Metadata = {
  title: "Harmony AI Workbench",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-admin-theme="light" suppressHydrationWarning>
      <body className="admin-theme-light" suppressHydrationWarning>
        <Script
          id="admin-theme-preload"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var key = "hm_admin_theme_mode";
                  var value = localStorage.getItem(key);
                  var mode = value === "light" || value === "dark" ? value : "light";
                  document.documentElement.setAttribute("data-admin-theme", mode);
                  document.body.classList.remove("admin-theme-light", "admin-theme-dark");
                  document.body.classList.add(mode === "light" ? "admin-theme-light" : "admin-theme-dark");
                } catch (e) {
                  document.documentElement.setAttribute("data-admin-theme", "light");
                  document.body.classList.add("admin-theme-light");
                }
              })();
            `,
          }}
        />
        <AntdStyleRegistry>
          <AntdProvider>{children}</AntdProvider>
        </AntdStyleRegistry>
      </body>
    </html>
  );
}
