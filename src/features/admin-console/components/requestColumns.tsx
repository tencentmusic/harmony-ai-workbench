"use client";

import { Space, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import type { RequestRow } from "../types";
import { sortDate, sortNum, sortStr } from "../lib/adminColumnHelpers";

const { Text } = Typography;

export function createRequestColumns(): TableProps<RequestRow>["columns"] {
  return [
    {
      ...sortDate<RequestRow>((row) => row.createdAt, "时间"),
      width: 180,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>{new Date(row.createdAt).toLocaleString()}</Text>
          <Text type="secondary">ID: {row.id}</Text>
        </Space>
      ),
    },
    {
      title: "人员",
      width: 170,
      sorter: (a, b) => {
        const an = a.token ? `${a.token.personName}${a.token.personCode}` : "";
        const bn = b.token ? `${b.token.personName}${b.token.personCode}` : "";
        return an.localeCompare(bn, "zh-CN");
      },
      render: (_, row) => (row.token ? `${row.token.personName}（${row.token.personCode}）` : "-"),
    },
    {
      title: "模式",
      width: 96,
      sorter: (a, b) => String(a.mode).localeCompare(String(b.mode)),
      render: (_, row) => (
        <Tag color={row.mode === "opencode" ? "blue" : "default"}>{row.mode === "opencode" ? "OpenCode" : "Convert"}</Tag>
      ),
    },
    {
      ...sortStr<RequestRow>("status", "状态"),
      width: 92,
      render: (_, row) => (
        <Tag color={row.status === "done" ? "success" : row.status === "failed" ? "error" : "processing"}>
          {row.status === "done" ? "完成" : row.status === "failed" ? "失败" : "进行中"}
        </Tag>
      ),
    },
    {
      title: "模型",
      width: 250,
      ellipsis: true,
      sorter: (a, b) =>
        `${a.model.displayName || ""}${a.model.model || a.model.id}`.localeCompare(
          `${b.model.displayName || ""}${b.model.model || b.model.id}`,
          "zh-CN",
        ),
      render: (_, row) => `${row.model.displayName || "-"} / ${row.model.model || row.model.id}`,
    },
    { ...sortStr<RequestRow>("module", "模块"), width: 210, ellipsis: true },
    { ...sortStr<RequestRow>("classFqn", "类"), width: 290, ellipsis: true },
    {
      title: "耗时",
      width: 90,
      sorter: (a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0),
      render: (_, row) => (row.durationMs == null ? "-" : `${Math.round(row.durationMs / 1000)}s`),
    },
    { ...sortStr<RequestRow>("errorPreview", "错误摘要"), ellipsis: true },
  ];
}
