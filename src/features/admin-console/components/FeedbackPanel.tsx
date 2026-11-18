"use client";

import { Button, Card, Empty, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { FeedbackRow } from "../types";
import { AdminTable } from "./AdminTable";
import { sortDate, sortStr } from "../lib/adminColumnHelpers";

const { Paragraph, Text } = Typography;

type Props = {
  busy: boolean;
  rows: FeedbackRow[];
  onRefresh: () => void;
};

export function FeedbackPanel(props: Props) {
  const columns: ColumnsType<FeedbackRow> = [
    {
      ...sortStr<FeedbackRow>("content", "反馈内容"),
      render: (value: string) => <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{value}</Paragraph>,
    },
    {
      title: "提交人",
      width: 220,
      sorter: (a, b) => {
        const an = a.token ? `${a.token.personName}${a.token.personCode}` : "";
        const bn = b.token ? `${b.token.personName}${b.token.personCode}` : "";
        return an.localeCompare(bn, "zh-CN");
      },
      render: (_, row) =>
        row.token ? (
          <Text>
            {row.token.personName || "-"}（{row.token.personCode || "-"}）
          </Text>
        ) : (
          <Text type="secondary">未知用户</Text>
        ),
    },
    {
      ...sortDate<FeedbackRow>((row) => row.createdAt, "提交时间"),
      width: 190,
      render: (value: string) => new Date(value).toLocaleString(),
    },
  ];

  return (
    <Card title="用户反馈" extra={<Button loading={props.busy} onClick={props.onRefresh}>刷新</Button>}>
      <AdminTable<FeedbackRow>
        tableKey="feedback"
        rowKey="id"
        columns={columns}
        dataSource={props.rows}
        bordered
        size="middle"
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无反馈" /> }}
      />
    </Card>
  );
}
