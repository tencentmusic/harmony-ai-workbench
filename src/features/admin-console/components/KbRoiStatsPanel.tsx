"use client";



import { useMemo, type ReactNode } from "react";

import { QuestionCircleOutlined } from "@ant-design/icons";

import { Alert, Card, Col, Popover, Row, Segmented, Space, Statistic, Tooltip, Typography } from "antd";
import type { OverviewChartRange } from "@/lib/admin-overview-range";
import { OVERVIEW_CHART_RANGE_LABEL } from "@/lib/admin-overview-range";

import type { TableProps } from "antd";

import type { KbRoiStatsState } from "../types";
import { AdminTable } from "./AdminTable";
import { useAdminTablePageSize } from "../context/AdminTablePageSizeContext";
import { adminTableScrollY } from "../lib/adminTableConfig";
import { sortNum, sortStr } from "../lib/adminColumnHelpers";



const { Title, Text } = Typography;



type Props = {

  busy: boolean;

  range: OverviewChartRange;

  error?: string | null;

  kpi: KbRoiStatsState["kpi"];

  byFeature: KbRoiStatsState["byFeature"];

  byDelivery: KbRoiStatsState["byDelivery"];

  cohort: KbRoiStatsState["cohort"];

  daily: KbRoiStatsState["daily"];

  byCodegraphTool: KbRoiStatsState["byCodegraphTool"];

  onRangeChange: (range: OverviewChartRange) => void;

};



const DELIVERY_LABELS: Record<string, string> = {

  bff_prompt_inject: "工台自动注入",

  bff_intent_only: "工台对话（源码/URL）",

  mcp_tool: "知识库 MCP",

  codegraph_mcp: "代码图谱 MCP",

  agent_native: "Agent 裸工具",

  skill_pack: "Skill 产出",

  test: "测试",

  "(none)": "缺省（旧数据）",

};



const BUCKET_LABELS: Record<string, string> = {

  "harmony-kb": "结构化知识库",

  "harmony-docs": "迁移文档",

  "android-src": "Android 源码",

  "harmony-src": "鸿蒙源码",

  kb_pack: "工台知识库（L1）",

  codegraph_index: "代码图谱索引（L2）",

  raw_scan: "裸扫描（glob/grep/read）",

  other: "未识别路径",

  class_name: "工台知识库（L1）",

  feature_id: "工台知识库（L1）",

  "(none)": "未标注",

};



const COHORT_LABELS: Record<string, string> = {

  kb_only: "仅工台知识库（理想）",

  kb_plus_codegraph: "知识库 + 代码索引补位",

  codegraph_only: "仅代码图谱",

  raw_scan: "裸 glob/grep/read",

  kb_mixed: "知识库 + 裸扫描",

  kb_off: "无知识库注入",

  "(none)": "未标注",

};



/** 与 KPI / 三层检索说明对齐的列名 */
const L1_EVENT_COL = "L1 工台知识库";
const L2_EVENT_COL = "L2 有效命中";
const L2_CALL_COL = "L2 调用";
const RAW_SCAN_COL = "裸扫描";

type LayerSummaryRow = {
  key: string;
  layer: string;
  events: number;
  share_pct: number | null;
};

const CONSUMER_LABELS: Record<string, string> = {

  "workbench-bff": "Harmony AI Workbench",

  "cursor-agent": "Cursor MCP",

  "codex-agent": "Codex MCP",

  "mcp-direct": "Cursor / Codex MCP（旧）",

  "opencode-bridge": "OpenCode 监听",

  "opencode-mcp": "OpenCode MCP",

  "kb-mcp-for-zc": "驻场 MCP",

  benchmark: "基准测试",

  ingest: "采集服务",

};



function labelOf(map: Record<string, string>, raw: string) {

  const key = String(raw || "").trim();

  if (!key) return "—";

  return map[key] || key;

}

function buildLayerSummary(daily: KbRoiStatsState["daily"]): LayerSummaryRow[] {
  const l1 = daily.reduce((sum, row) => sum + Number(row.context_served || 0), 0);
  const l2 = daily.reduce((sum, row) => sum + Number(row.graph_query_hit ?? 0), 0);
  const rawScan = daily.reduce((sum, row) => sum + Number(row.raw_scan ?? row.tool_call ?? 0), 0);
  const total = l1 + l2 + rawScan;

  const share = (events: number) => (total > 0 ? Math.round((events / total) * 100) : null);

  return [
    { key: "L1", layer: L1_EVENT_COL, events: l1, share_pct: share(l1) },
    { key: "L2", layer: L2_EVENT_COL, events: l2, share_pct: share(l2) },
    { key: "RAW", layer: RAW_SCAN_COL, events: rawScan, share_pct: share(rawScan) },
  ];
}



function StatsCard(props: { title: string; children: ReactNode; extra?: ReactNode }) {

  return (

    <Card className="admin-card" title={props.title} extra={props.extra} style={{ height: "100%" }}>

      {props.children}

    </Card>

  );

}



function KpiCard(props: {
  title: string
  value: string | number
  suffix?: string
  hint?: ReactNode
  help?: ReactNode
  background?: string
}) {

  return (

    <Card
      className="admin-card"
      style={{
        height: "100%",
        position: "relative",
        background: props.background,
        border: "2px solid #ffffff",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.06)",
      }}
      styles={{ body: { padding: "20px 24px" } }}
    >

      {props.help ? (
        <Popover content={props.help} trigger="hover" placement="topRight" overlayStyle={{ maxWidth: 360 }}>
          <QuestionCircleOutlined
            aria-label="指标说明"
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              color: "rgba(0,0,0,0.45)",
              cursor: "help",
              fontSize: 14,
            }}
          />
        </Popover>
      ) : null}

      <Statistic
        title={props.title}
        value={props.value}
        suffix={
          props.suffix ? (
            <span style={{ fontSize: 24, fontWeight: 600, color: "rgba(0, 0, 0, 0.65)" }}>{props.suffix}</span>
          ) : undefined
        }
        valueStyle={{
          fontSize: 40,
          fontWeight: 700,
          lineHeight: 1.15,
          color: "rgba(0, 0, 0, 0.88)",
        }}
        style={{ marginBottom: 0 }}
      />

      {props.hint ? (

        <div style={{ marginTop: 8, fontSize: 12, color: "rgba(0,0,0,0.45)", lineHeight: 1.55 }}>

          {props.hint}

        </div>

      ) : null}

    </Card>

  );

}



export function KbRoiStatsPanel(props: Props) {

  const { pageSize } = useAdminTablePageSize();
  const tableScrollY = adminTableScrollY(pageSize, 39, 40, 320);

  const callReduction =
    props.kpi.call_reduction_pct == null ? "—" : `${props.kpi.call_reduction_pct}%`;
  const rawScanCompareHint =
    props.kpi.no_index_turns > 0 && props.kpi.with_index_turns > 0
      ? `无索引 ${props.kpi.avg_raw_scan_no_index} 次/轮 → 有索引 ${props.kpi.avg_raw_scan_with_index} 次/轮（${props.kpi.no_index_turns}/${props.kpi.with_index_turns} 轮）`
      : "按轮分组：无 L1 且 L2 有效命中=0 vs 有索引命中";
  const backfillDisplay =
    props.kpi.codegraph_backfill_denominator > 0
      ? `${props.kpi.codegraph_backfill_turns}/${props.kpi.codegraph_backfill_denominator}${
          props.kpi.codegraph_backfill_rate_pct == null ? "" : ` (${props.kpi.codegraph_backfill_rate_pct}%)`
        }`
      : props.kpi.codegraph_backfill_turns;

  const layerSummary = useMemo(() => buildLayerSummary(props.daily), [props.daily]);
  const periodTurns = useMemo(
    () => props.daily.reduce((sum, row) => sum + Number(row.turns || 0), 0),
    [props.daily],
  );



  const featureColumns: TableProps<KbRoiStatsState["byFeature"][0]>["columns"] = [

    { ...sortStr<KbRoiStatsState["byFeature"][0]>("feature_id", "功能标识"), ellipsis: true },

    { ...sortNum<KbRoiStatsState["byFeature"][0]>("context_served", L1_EVENT_COL), width: 108 },

    { ...sortNum<KbRoiStatsState["byFeature"][0]>("graph_query_hit", L2_EVENT_COL), width: 100 },

    { ...sortNum<KbRoiStatsState["byFeature"][0]>("graph_query", L2_CALL_COL), width: 88 },

    { ...sortNum<KbRoiStatsState["byFeature"][0]>("match_hit", "命中"), width: 72 },

    { ...sortNum<KbRoiStatsState["byFeature"][0]>("match_attempt", "匹配尝试"), width: 88 },

    {
      title: (
        <Tooltip title="Agent 通过 read/glob/grep 触达知识库、文档或源码路径的次数；与裸扫描独立统计，仅作辅助参考">
          路径触达
        </Tooltip>
      ),
      dataIndex: "artifact_read",
      width: 88,
      sorter: (a, b) => Number(a.artifact_read || 0) - Number(b.artifact_read || 0),
    },

  ];



  const deliveryColumns: TableProps<KbRoiStatsState["byDelivery"][0]>["columns"] = [

    {
      ...sortStr<KbRoiStatsState["byDelivery"][0]>("delivery", "渠道"),
      width: 140,
      render: (v: string) => labelOf(DELIVERY_LABELS, v),
    },

    {
      ...sortStr<KbRoiStatsState["byDelivery"][0]>("bucket", "数据域"),
      width: 160,
      render: (v: string) => labelOf(BUCKET_LABELS, v),
    },

    { ...sortNum<KbRoiStatsState["byDelivery"][0]>("count", "次数"), width: 72 },

  ];



  const cohortColumns: TableProps<KbRoiStatsState["cohort"][0]>["columns"] = [

    { ...sortStr<KbRoiStatsState["cohort"][0]>("cohort", "分组"), width: 150, render: (v: string) => labelOf(COHORT_LABELS, v) },

    { ...sortStr<KbRoiStatsState["cohort"][0]>("kb_version", "知识库版本"), width: 120, ellipsis: true },

    { ...sortStr<KbRoiStatsState["cohort"][0]>("consumer", "来源"), width: 130, render: (v: string) => labelOf(CONSUMER_LABELS, v) },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("turns", "轮次"), width: 64 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_tool_calls", "均工具调用"), width: 96 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_kb_context_served", "均 L1 工台知识库"), width: 120 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_codegraph_hits", "均 L2 有效命中"), width: 120 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_codegraph_calls", "均 L2 调用"), width: 96 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_raw_tool_calls", "均裸扫描"), width: 100 },

    { ...sortNum<KbRoiStatsState["cohort"][0]>("avg_duration_ms", "均耗时(ms)"), width: 96 },

  ];



  const layerSummaryColumns: TableProps<LayerSummaryRow>["columns"] = [
    { ...sortStr<LayerSummaryRow>("layer", "层级"), width: 140 },
    { ...sortNum<LayerSummaryRow>("events", "事件数"), width: 88 },
    {
      title: "占比",
      dataIndex: "share_pct",
      width: 72,
      sorter: (a, b) => Number(a.share_pct || 0) - Number(b.share_pct || 0),
      render: (value: number | null) => (value == null ? "—" : `${value}%`),
    },
  ];

  const dailyColumns: TableProps<KbRoiStatsState["daily"][0]>["columns"] = [

    { ...sortStr<KbRoiStatsState["daily"][0]>("day", "日期"), width: 120 },

    { ...sortNum<KbRoiStatsState["daily"][0]>("context_served", L1_EVENT_COL), width: 108 },

    { ...sortNum<KbRoiStatsState["daily"][0]>("graph_query_hit", L2_EVENT_COL), width: 100 },

    { ...sortNum<KbRoiStatsState["daily"][0]>("graph_query", L2_CALL_COL), width: 88 },

    { ...sortNum<KbRoiStatsState["daily"][0]>("raw_scan", RAW_SCAN_COL), width: 88 },

    { ...sortNum<KbRoiStatsState["daily"][0]>("turns", "对话轮次"), width: 88 },

  ];



  const codegraphColumns: TableProps<KbRoiStatsState["byCodegraphTool"][0]>["columns"] = [

    { ...sortStr<KbRoiStatsState["byCodegraphTool"][0]>("tool_name", "MCP 工具") },

    { ...sortNum<KbRoiStatsState["byCodegraphTool"][0]>("count", "调用次数"), width: 88 },

    { ...sortNum<KbRoiStatsState["byCodegraphTool"][0]>("hit_count", "有效命中"), width: 88 },

    { ...sortNum<KbRoiStatsState["byCodegraphTool"][0]>("avg_latency_ms", "均延迟(ms)"), width: 96 },

    {
      title: (
        <Tooltip title="单次 MCP 调用返回的结果条数（hits/callers 等）的平均值，不是总命中次数">
          均单次结果数
        </Tooltip>
      ),
      dataIndex: "avg_results",
      width: 108,
      sorter: (a, b) => Number(a.avg_results || 0) - Number(b.avg_results || 0),
    },

  ];



  return (

    <Space direction="vertical" style={{ width: "100%" }} size={12}>

      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>

        <Title level={2} style={{ margin: 0 }}>
          知识库看板
        </Title>

        <Segmented

          className="admin-overview-range-segmented"

          value={props.range}

          disabled={props.busy}

          onChange={(value) => props.onRangeChange(value as OverviewChartRange)}

          onClick={(event) => {

            const item = (event.target as HTMLElement).closest(".ant-segmented-item");

            if (item?.classList.contains("ant-segmented-item-selected")) {

              props.onRangeChange(props.range);

            }

          }}

          options={[

            { label: OVERVIEW_CHART_RANGE_LABEL.last7d, value: "last7d" },

            { label: OVERVIEW_CHART_RANGE_LABEL.thisMonth, value: "thisMonth" },

            { label: OVERVIEW_CHART_RANGE_LABEL.lastMonth, value: "lastMonth" },

            { label: OVERVIEW_CHART_RANGE_LABEL.all, value: "all" },

          ]}

        />

      </Space>



      {props.error ? (

        <Alert type="warning" showIcon message="遥测服务不可用" description={props.error} />

      ) : null}



      <Row gutter={[12, 12]}>

        <Col xs={24} sm={12} lg={6}>

          <KpiCard
            title="索引覆盖率"
            value={props.kpi.index_coverage_pct}
            suffix="%"
            hint="L1 工台注入或 L2 代码图谱有效命中的对话占比"
            background="#e6f4ff"
          />

        </Col>

        <Col xs={24} sm={12} lg={6}>

          <KpiCard
            title="平均裸扫描次数减少"
            value={callReduction}
            hint={rawScanCompareHint}
            background="#f6ffed"
            help={
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                <div>
                  <strong>无索引组</strong>：L1=0 且 L2 有效命中=0 的轮次，统计其 glob/grep/read 裸扫次数均值。
                </div>
                <div>
                  <strong>有索引组</strong>：L1&gt;0 或 L2 有效命中&gt;0 的轮次。
                </div>
                <div style={{ marginTop: 8 }}>
                  减少% = (无索引轮均裸扫 − 有索引轮均裸扫) / 无索引轮均裸扫 × 100%。任一组无轮次或无索引组裸扫为 0 时显示 —。
                </div>
              </div>
            }
          />

        </Col>

        <Col xs={24} sm={12} lg={6}>

          <KpiCard
            title="代码图谱 L2 补位"
            value={backfillDisplay}
            hint="无 L1 工台注入时，由代码图谱有效命中补位的轮次占比"
            background="#f9f0ff"
          />

        </Col>

        <Col xs={24} sm={12} lg={6}>

          <KpiCard title="总对话轮次" value={props.kpi.total_turns} background="#fff7e6" />

        </Col>

      </Row>



      <Alert

        type="info"

        showIcon

        message="三层检索：L1 结构化知识库 → L2 代码图谱 → 裸扫描源码"

        description="L1 = 业务知识、规则和双端代码地图命中。L2 = 代码图谱 MCP 有效命中（result_count>0）。裸扫描 = Agent 在项目范围内直接 grep/read 源码。"

      />



      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>

        <StatsCard title="代码图谱 MCP 工具（L2 明细）">

          {props.byCodegraphTool.length ? (
            <>
              <AdminTable tableKey="kb-roi-codegraph-tools" rowKey="tool_name" size="small" paginationPreset="none" columns={codegraphColumns} dataSource={props.byCodegraphTool} />
              <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
                调用次数 = 全部 MCP 调用；有效命中 = result_count&gt;0 且无 error。均单次结果数 = AVG(result_count)。
              </Text>
            </>
          ) : (
            <Text type="secondary">
              暂无 L2 调用。OpenCode / Cursor 需通过 android-harmony-kb-mcp 调用 kb_codegraph_search / callers / impact 后才会出现数据（裸 read/glob 不计入）。
            </Text>
          )}

        </StatsCard>

        <StatsCard title="对话分组对比（ROI 口径）">

          <AdminTable
            tableKey="kb-roi-cohort"
            rowKey={(row) => `${row.cohort}::${row.kb_version}::${row.consumer}`}

            size="small"

            scroll={{ x: 900, y: tableScrollY }}

            columns={cohortColumns}

            dataSource={props.cohort}

          />

          <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
            按对话轮次分组对比均耗时与均裸工具数，用于「大模型调用次数减少」等 ROI 指标；cohort 与 KPI 均按 trace 关联的实际工具事件重算。
          </Text>

        </StatsCard>

      </div>



      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>

        <StatsCard title="按功能统计">

          <AdminTable tableKey="kb-roi-by-feature" rowKey="feature_id" size="small" scroll={{ y: tableScrollY }} columns={featureColumns} dataSource={props.byFeature} />

        </StatsCard>

        <StatsCard title="渠道 × 数据域">

          <AdminTable
            tableKey="kb-roi-by-delivery"
            rowKey={(row) => `${row.delivery}::${row.bucket}`}

            size="small"

            scroll={{ y: tableScrollY }}

            columns={deliveryColumns}

            dataSource={props.byDelivery}

          />

          <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12, lineHeight: 1.55 }}>
            渠道 = 谁触发的检索（工台注入 / 代码图谱 MCP / Agent 裸工具）；数据域 = 读哪类资料，与 L1/L2 对应。
            鸿蒙源码仅在 Agent 实际 read/glob 到 harmony-src 或 .ets 路径时才会出现；当前会话若主要在查 Android，表中可能只有 Android 源码。
          </Text>

        </StatsCard>

      </div>



      <StatsCard title="三层检索统计">

        <Space direction="vertical" style={{ width: "100%" }} size={12}>

          <div>
            <Text strong>周期汇总</Text>
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              {OVERVIEW_CHART_RANGE_LABEL[props.range]} · 对话轮次 {periodTurns}
            </Text>
            <AdminTable
              tableKey="kb-roi-layer-summary"
              rowKey="key"
              size="small"
              paginationPreset="none"
              style={{ marginTop: 8 }}
              columns={layerSummaryColumns}
              dataSource={layerSummary}
            />
          </div>

          <div>
            <Text strong>按日明细</Text>
            <AdminTable tableKey="kb-roi-daily" rowKey="day" size="small" style={{ marginTop: 8 }} columns={dailyColumns} dataSource={props.daily} />
          </div>

        </Space>

        <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          L1 = 业务知识与双端代码地图 · L2 = 代码图谱有效命中 · 裸扫描 = scoped grep/read。L2 调用列见按日明细。
        </Text>

      </StatsCard>

    </Space>

  );

}


