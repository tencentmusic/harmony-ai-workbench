"use client";

import { useEffect } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { Button, Card, DatePicker, Empty, Select, Space, Typography } from "antd";
import type { RequestRow, TokenRow } from "../types";
import { createRequestColumns } from "./requestColumns";
import { AdminTable } from "./AdminTable";
import { AttachmentList } from "@/features/chat-workbench/components/AttachmentList";
import { MarkdownMessage } from "@/features/chat-workbench/components/MarkdownMessage";
import { OpencodeImageAttachments } from "@/features/chat-workbench/components/OpencodeImageAttachments";
import { collectOpencodeImages, stripOpencodeAssetContentFromMarkdown } from "@/lib/opencode/opencode-image";
import { useAdminTablePagination } from "../hooks/useAdminTablePagination";
import styles from "./RequestsPanel.module.css";

const { Paragraph, Text } = Typography;

type Props = {
  busy: boolean;
  recordTokenId: string;
  requestStatus: string;
  dateRange: { startDate: string; endDate: string };
  tokens: TokenRow[];
  requestRows: RequestRow[];
  isDark: boolean;
  onDateRangeChange: (range: { startDate: string; endDate: string }) => void;
  onTokenChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRefresh: () => void;
};

export function RequestsPanel(props: Props) {
  const columns = createRequestColumns();
  const pickerValue: [Dayjs, Dayjs] = [dayjs(props.dateRange.startDate), dayjs(props.dateRange.endDate)];
  const { resetPage } = useAdminTablePagination();

  useEffect(() => {
    resetPage();
  }, [props.recordTokenId, props.requestStatus, props.dateRange.startDate, props.dateRange.endDate, resetPage]);

  function renderModelOutput(row: RequestRow) {
    const images = collectOpencodeImages({
      extra: row.outputImages,
      content: row.modelOutput,
    });
    const displayContent = images.length
      ? stripOpencodeAssetContentFromMarkdown(row.modelOutput || "")
      : row.modelOutput || "";
    return (
      <div className={styles.resultPane}>
        <OpencodeImageAttachments images={images} authMode="admin" />
        {displayContent ? (
          <MarkdownMessage content={displayContent} themeMode={props.isDark ? "dark" : "light"} authMode="admin" />
        ) : images.length ? null : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无输出结果" />
        )}
      </div>
    );
  }

  function renderUserInput(row: RequestRow) {
    const hasText = !!row.userInput?.trim();
    const attachments = row.userAttachments || [];
    if (!hasText && !attachments.length) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未关联到聊天输入" />;
    }
    return (
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        <AttachmentList attachments={attachments} compact authMode="admin" />
        {hasText ? <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{row.userInput}</Paragraph> : null}
      </Space>
    );
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Card title="AI问答记录筛选">
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
              value={props.recordTokenId || undefined}
              allowClear
              onChange={(v: string | undefined) => props.onTokenChange(v || "")}
              options={props.tokens.map((t) => ({ value: t.id, label: `${t.personName}（${t.personCode}）` }))}
            />
            <Select
              style={{ width: 180 }}
              placeholder="按状态过滤"
              value={props.requestStatus || undefined}
              allowClear
              onChange={(v: string | undefined) => props.onStatusChange(v || "")}
              options={[
                { value: "pending", label: "等待中" },
                { value: "running", label: "运行中" },
                { value: "done", label: "完成" },
                { value: "failed", label: "失败" },
                { value: "canceled", label: "已取消" },
              ]}
            />
            <Button loading={props.busy} onClick={props.onRefresh}>
              刷新记录
            </Button>
          </Space>
        </Card>
        <Card title="AI问答明细">
          <AdminTable<RequestRow>
            tableKey="requests"
            rowKey="id"
            columns={columns}
            dataSource={props.requestRows}
            bordered
            size="middle"
            expandable={{
              expandedRowRender: (row) => (
                <Space direction="vertical" style={{ width: "100%" }} size={12}>
                  <Card size="small" title="用户发送内容">
                    {renderUserInput(row)}
                  </Card>
                  <Card size="small" title="大模型返回结果">
                    {row.modelOutput || row.outputImages?.length ? (
                      renderModelOutput(row)
                    ) : row.outputPurgedAt ? (
                      <Text type="secondary">结果已按保留策略清理（{new Date(row.outputPurgedAt).toLocaleString()}）</Text>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无输出结果" />
                    )}
                  </Card>
                </Space>
              ),
            rowExpandable: (row) => Boolean(row.userInput || row.userAttachments?.length || row.modelOutput || row.outputImages?.length || row.outputPurgedAt),
          }}
        />
      </Card>
    </Space>
  );
}

