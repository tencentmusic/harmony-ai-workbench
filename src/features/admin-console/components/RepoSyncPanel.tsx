"use client";

import { useCallback, useMemo, useState } from "react";
import { Button, Card, Select, Space, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import type { RepoSyncRepoRow, RepoSyncRunRow } from "../types";
import { AdminTable } from "./AdminTable";
import { sortStr } from "../lib/adminColumnHelpers";
import {
  describeRepoSyncFollowUps,
  plannedFollowUpsForRepoIds,
} from "@/features/admin-console/lib/repoSyncFollowUp";

type Props = {
  busy: boolean;
  rebuildingClassIndex?: boolean;
  queueDepth: number;
  repos: RepoSyncRepoRow[];
  runs: RepoSyncRunRow[];
  onRefresh: () => void;
  onTrigger: (repoId: string, branch?: string) => void;
  onRebuildIndex?: () => void;
};

function formatShanghaiTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function statusTag(status: string) {
  if (status === "success") return <Tag color="green">成功</Tag>;
  if (status === "failed") return <Tag color="red">失败</Tag>;
  if (status === "running") return <Tag color="blue">执行中</Tag>;
  if (status === "queued") return <Tag color="gold">排队</Tag>;
  if (status === "cancelled") return <Tag>已取消</Tag>;
  return <Tag>{status}</Tag>;
}

export function RepoSyncPanel(props: Props) {
  const [repoId, setRepoId] = useState(props.repos[0]?.id || "");
  const [branch, setBranch] = useState("");

  const repoOptions = useMemo(
    () => props.repos.map((r) => ({ value: r.id, label: `${r.label} (${r.id})` })),
    [props.repos],
  );

  const selectedRepo = props.repos.find((r) => r.id === repoId);
  const branchOptions = useMemo(() => {
    const branches = selectedRepo?.track_branches || [];
    return branches.map((b) => ({ value: b, label: b }));
  }, [selectedRepo]);

  const rowKey = useCallback((row: RepoSyncRunRow) => row.id, []);

  const columns: TableProps<RepoSyncRunRow>["columns"] = useMemo(
    () => [
      {
        ...sortStr<RepoSyncRunRow>("created_at", "时间"),
        width: 180,
        render: (value: string) => formatShanghaiTime(value),
      },
      { ...sortStr<RepoSyncRunRow>("repo_id", "仓库"), width: 160 },
      { ...sortStr<RepoSyncRunRow>("branch", "分支"), width: 120 },
      { ...sortStr<RepoSyncRunRow>("trigger", "触发"), width: 120 },
      {
        title: "状态",
        dataIndex: "status",
        width: 90,
        render: (_, row) => statusTag(row.status),
      },
      {
        title: "Git",
        width: 180,
        render: (_, row) =>
          row.git_rev_after ? (
            <Typography.Text code copyable={{ text: row.git_rev_after }}>
              {row.git_rev_after.slice(0, 8)}
            </Typography.Text>
          ) : (
            "—"
          ),
      },
      {
        title: "执行任务",
        width: 280,
        render: (_, row) => {
          const lines = describeRepoSyncFollowUps(
            row.result,
            plannedFollowUpsForRepoIds(row.repo_id, props.repos),
          );
          return (
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {lines.join("\n")}
            </Typography.Text>
          );
        },
      },
      {
        title: "错误",
        dataIndex: "error_message",
        ellipsis: true,
        render: (v: string | null) => v || "—",
      },
    ],
    [props.repos],
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title="手动触发" size="small">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <Space wrap>
            <Select
              style={{ minWidth: 220 }}
              value={repoId || undefined}
              options={repoOptions}
              placeholder="选择仓库"
              onChange={(v) => {
                setRepoId(v);
                setBranch("");
              }}
            />
            <Select
              style={{ minWidth: 180 }}
              value={branch || undefined}
              options={branchOptions}
              placeholder="分支（默认首条）"
              allowClear
              onChange={(v) => setBranch(v || "")}
            />
            <Button
              type="primary"
              loading={props.busy}
              disabled={!repoId}
              onClick={() => props.onTrigger(repoId, branch || undefined)}
            >
              手动更新仓库
            </Button>
          </Space>
          <Space wrap>
            <Tag>队列深度: {props.queueDepth}</Tag>
            <Button onClick={props.onRefresh} loading={props.busy}>
              刷新
            </Button>
            {props.onRebuildIndex ? (
              <Button onClick={props.onRebuildIndex} loading={props.rebuildingClassIndex}>
                补跑完整类索引
              </Button>
            ) : null}
          </Space>
        </div>
      </Card>

      <Card title="更新记录" size="small">
        <AdminTable rowKey={rowKey} columns={columns} dataSource={props.runs} pagination={{ pageSize: 20 }} />
      </Card>
    </Space>
  );
}
