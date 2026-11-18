"use client";

import { useEffect, useMemo } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Flex, Input, Popover, Select, Space, Statistic, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { MCP_AUDIT_CONSUMERS, MCP_CONSUMER_LABELS, MCP_ZC_CONSUMERS } from "@/lib/kb-mcp-audit-constants";
import type { TokenRow, ZcMcpAuditRow } from "../types";
import { AdminTable } from "./AdminTable";
import { useAdminTablePagination } from "../hooks/useAdminTablePagination";

const { Text } = Typography;

function consumerLabel(raw: string) {
  const key = String(raw || "").trim();
  return MCP_CONSUMER_LABELS[key] || key || "—";
}

type Props = {
  busy: boolean;
  days: number;
  consumer: string;
  apiTokenId: string;
  tool: string;
  eventType: string;
  hit: string;
  dateRange: { startDate: string; endDate: string };
  tokens: TokenRow[];
  rows: ZcMcpAuditRow[];
  total: number;
  byTool: Array<{ tool: string; count: number }>;
  byConsumer: Array<{ consumer: string; count: number }>;
  onDaysChange: (days: number) => void;
  onDateRangeChange: (range: { startDate: string; endDate: string }) => void;
  onConsumerChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onToolChange: (value: string) => void;
  onEventTypeChange: (value: string) => void;
  onHitChange: (value: string) => void;
  onRefresh: () => void;
};

export function ZcMcpAuditPanel(props: Props) {
  const pickerValue: [Dayjs, Dayjs] = [dayjs(props.dateRange.startDate), dayjs(props.dateRange.endDate)];
  const { resetPage } = useAdminTablePagination();

  useEffect(() => {
    resetPage();
  }, [
    props.apiTokenId,
    props.consumer,
    props.tool,
    props.eventType,
    props.hit,
    props.dateRange.startDate,
    props.dateRange.endDate,
    resetPage,
  ]);

  const columns: ColumnsType<ZcMcpAuditRow> = useMemo(
    () => [
      { title: "时间", dataIndex: "ts", width: 190, render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss") },
      { title: "工具", dataIndex: "toolName", width: 180, render: (v: string | null) => v || "—" },
      { title: "来源", dataIndex: "consumer", width: 160, render: (v: string) => consumerLabel(v) },
      { title: "人员", width: 120, render: (_: unknown, row) => row.personName || row.personCode || "—" },
      { title: "Token", dataIndex: "mcpTokenId", width: 120, ellipsis: true, render: (v: string | null) => v || "—" },
      {
        title: "结果",
        width: 80,
        render: (_: unknown, row) =>
          row.hit === null ? <Tag>—</Tag> : row.hit ? <Tag color="success">命中</Tag> : <Tag color="error">未命中</Tag>,
      },
      { title: "耗时ms", dataIndex: "latencyMs", width: 90, render: (v: number | null) => (v != null ? v : "—") },
      { title: "事件", dataIndex: "eventType", width: 140 },
      {
        title: "详情",
        ellipsis: true,
        render: (_: unknown, row) => (
          <Text type="secondary" ellipsis>
            {row.error || row.querySymbol || row.featureId || "—"}
          </Text>
        ),
      },
    ],
    [],
  );

  const consumerCounts = useMemo(() => {
    const map = new Map(props.byConsumer.map((x) => [x.consumer, x.count]));
    const zcCount = MCP_ZC_CONSUMERS.reduce((sum, id) => sum + (map.get(id) || 0), 0);
    const codegraphCount = map.get("kb-mcp-for-codegraph") || 0;
    const opencodeCount = map.get("opencode-mcp") || 0;
    return [
      {
        id: "zc",
        label: "驻场 MCP",
        count: zcCount,
        help: "Cursor / Codex 等本地 Agent，经 HTTP Gateway 查知识库和源码",
      },
      {
        id: "kb-mcp-for-codegraph",
        label: "CodeGraph MCP",
        count: codegraphCount,
        help: "代码图谱专用，查类、调用链、影响面",
      },
      {
        id: "opencode-mcp",
        label: "OpenCode MCP",
        count: opencodeCount,
        help: "工台 AI 问答里的 OpenCode 调 MCP",
      },
    ];
  }, [props.byConsumer]);

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Card title="MCP 工具调用记录">
        <Space wrap>
          <DatePicker.RangePicker
            allowClear={false}
            value={pickerValue}
            onChange={(values) => {
              if (!values || !values[0] || !values[1]) return;
              props.onDateRangeChange({
                startDate: values[0].format("YYYY-MM-DD"),
                endDate: values[1].format("YYYY-MM-DD"),
              });
            }}
          />
          <Select
            style={{ width: 240 }}
            placeholder="来源（全部）"
            allowClear
            value={props.consumer || undefined}
            onChange={(v) => props.onConsumerChange(v || "")}
            options={MCP_AUDIT_CONSUMERS.map((id) => ({
              value: id,
              label: consumerLabel(id),
            }))}
          />
          <Select
            style={{ width: 280 }}
            placeholder="按 Token"
            allowClear
            value={props.apiTokenId || undefined}
            onChange={(v) => props.onTokenChange(v || "")}
            options={props.tokens.map((t) => ({ value: t.id, label: `${t.personName}（${t.personCode}）` }))}
          />
          <Input
            style={{ width: 160 }}
            placeholder="工具名 tool"
            value={props.tool}
            allowClear
            onChange={(e) => props.onToolChange(e.target.value)}
          />
          <Select
            style={{ width: 180 }}
            placeholder="事件类型"
            allowClear
            value={props.eventType || undefined}
            onChange={(v) => props.onEventTypeChange(v || "")}
            options={[
              { value: "kb.tool_call", label: "kb.tool_call" },
              { value: "kb.graph_query", label: "kb.graph_query" },
              { value: "kb.context_served", label: "kb.context_served" },
              { value: "kb.match_attempt", label: "kb.match_attempt" },
            ]}
          />
          <Select
            style={{ width: 120 }}
            placeholder="命中"
            allowClear
            value={props.hit || undefined}
            onChange={(v) => props.onHitChange(v || "")}
            options={[
              { value: "1", label: "命中" },
              { value: "0", label: "未命中" },
            ]}
          />
          <Button loading={props.busy} type="primary" onClick={props.onRefresh}>
            查询
          </Button>
        </Space>
      </Card>

      <Flex wrap="wrap" align="stretch" gap={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic title="匹配条数" value={props.total} />
        </Card>
        {consumerCounts.map((x) => (
          <Card size="small" key={x.id} style={{ height: "100%" }}>
            <Statistic
              title={
                <span>
                  {x.label}{" "}
                  <Popover content={x.help} trigger="hover" placement="top">
                    <QuestionCircleOutlined
                      aria-label={`${x.label}说明`}
                      style={{ color: "rgba(0,0,0,0.45)", cursor: "help" }}
                    />
                  </Popover>
                </span>
              }
              value={x.count}
            />
          </Card>
        ))}
        <Card size="small" style={{ height: "100%", minWidth: 180 }}>
          <Statistic
            title="按工具 Top"
            valueRender={() =>
              props.byTool.length ? (
                <Space wrap size={4}>
                  {props.byTool.slice(0, 6).map((x) => (
                    <Tag key={x.tool}>
                      {x.tool}: {x.count}
                    </Tag>
                  ))}
                </Space>
              ) : (
                "—"
              )
            }
          />
        </Card>
      </Flex>

      <Card title="MCP 调用明细">
        <AdminTable<ZcMcpAuditRow>
          tableKey="zcMcpAudit"
          rowKey="id"
          columns={columns}
          dataSource={props.rows}
          bordered
          scroll={{ x: 1200 }}
        />
      </Card>
    </Space>
  );
}
