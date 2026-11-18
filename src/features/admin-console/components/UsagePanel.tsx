"use client";

import dayjs, { type Dayjs } from "dayjs";
import { Button, Card, DatePicker, Select, Space } from "antd";
import type { TableProps } from "antd";
import type { TokenRow, UsageRow } from "../types";
import { AdminTable } from "./AdminTable";
import { sortDate, sortStr } from "../lib/adminColumnHelpers";

type Props = {
  busy: boolean;
  usage: UsageRow[];
  tokens: TokenRow[];
  tokenId: string;
  dateRange: { startDate: string; endDate: string };
  onTokenChange: (value: string) => void;
  onDateRangeChange: (range: { startDate: string; endDate: string }) => void;
  onRefresh: () => void;
};

export function UsagePanel(props: Props) {
  const pickerValue: [Dayjs, Dayjs] = [dayjs(props.dateRange.startDate), dayjs(props.dateRange.endDate)];
  const usageColumns: TableProps<UsageRow>["columns"] = [
    { ...sortStr<UsageRow>("personName", "姓名") },
    { ...sortStr<UsageRow>("personCode", "工号") },
    {
      title: "总数",
      sorter: (a, b) => a.stats.total - b.stats.total,
      render: (_, row) => row.stats.total,
    },
    {
      title: "完成",
      sorter: (a, b) => a.stats.done - b.stats.done,
      render: (_, row) => row.stats.done,
    },
    {
      title: "失败",
      sorter: (a, b) => a.stats.failed - b.stats.failed,
      render: (_, row) => row.stats.failed,
    },
    {
      title: "运行中",
      sorter: (a, b) => a.stats.running - b.stats.running,
      render: (_, row) => row.stats.running,
    },
    {
      title: "等待中",
      sorter: (a, b) => a.stats.pending - b.stats.pending,
      render: (_, row) => row.stats.pending,
    },
    {
      ...sortDate<UsageRow>((row) => row.stats.lastAt, "最近任务"),
      render: (_, row) => (row.stats.lastAt ? new Date(row.stats.lastAt).toLocaleString() : "-"),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Card title="AI问答统计筛选">
        <Space wrap>
          <DatePicker.RangePicker
            allowClear={false}
            value={pickerValue}
            onChange={(values) => {
              if (!values || !values[0] || !values[1]) return;
              props.onDateRangeChange({ startDate: values[0].format("YYYY-MM-DD"), endDate: values[1].format("YYYY-MM-DD") });
            }}
          />
          <Select
            style={{ width: 360 }}
            placeholder="按 Token 过滤"
            value={props.tokenId || undefined}
            allowClear
            onChange={(v: string | undefined) => props.onTokenChange(v || "")}
            options={props.tokens.map((t) => ({ value: t.id, label: `${t.personName}（${t.personCode}）` }))}
          />
          <Button loading={props.busy} onClick={props.onRefresh}>
            刷新统计
          </Button>
        </Space>
      </Card>
      <Card className="admin-card" title="AI问答统计（按 Token）">
        <AdminTable<UsageRow> tableKey="usage" rowKey="id" columns={usageColumns} dataSource={props.usage} />
      </Card>
    </Space>
  );
}
