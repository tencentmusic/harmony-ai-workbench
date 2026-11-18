"use client";

import "@ant-design/v5-patch-for-react-19";
import { ConfigProvider, App as AntdApp, theme } from "antd";

export function AntdProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 10,
          colorBgBase: "#060b17",
          colorTextBase: "#f4f7ff",
          fontFamily: '"DIN Next","Avenir Next","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
        },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}
