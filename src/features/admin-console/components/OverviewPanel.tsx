"use client";

import { useMemo } from "react";
import { Card, Col, Empty, Row, Segmented, Space, Typography } from "antd";
import { Column, Line, Pie } from "@ant-design/plots";
import type { OverviewChartRange } from "@/lib/admin-overview-range";
import { PersonRankChart } from "./PersonRankChart";

const { Title } = Typography;

const CHART_RANGE_OPTIONS: Array<{ label: string; value: OverviewChartRange }> = [
  { label: "近 7 天", value: "last7d" },
  { label: "本月", value: "thisMonth" },
  { label: "上月", value: "lastMonth" },
  { label: "累计", value: "all" },
];

type Props = {
  isDark: boolean;
  chartRange: OverviewChartRange;
  chartRangeLabel: string;
  chartLoading?: boolean;
  onChartRangeChange: (range: OverviewChartRange) => void;
  tokenCount: number;
  appCount: number;
  migrationDocCount: number;
  taskTotalAllTime: number;
  usageSummary: { total: number; done: number; failed: number; running: number };
  line7d: Array<{ day: string; count: number }>;
  person7d: Array<{ person: string; count: number }>;
  personRank: Array<{ person: string; count: number }>;
};

export function OverviewPanel(props: Props) {
  const total = Math.max(props.usageSummary.total, props.usageSummary.done + props.usageSummary.failed + props.usageSummary.running, 1);
  const donePct = Math.round((props.usageSummary.done / total) * 100);
  const failedPct = Math.round((props.usageSummary.failed / total) * 100);
  const runningPct = Math.round((props.usageSummary.running / total) * 100);
  const statusItems = [
    { key: "done", label: "成功", value: props.usageSummary.done, pct: donePct, color: "#52c41a" },
    { key: "failed", label: "失败", value: props.usageSummary.failed, pct: failedPct, color: "#ff4d4f" },
    { key: "running", label: "运行中", value: props.usageSummary.running, pct: runningPct, color: "#1677ff" },
  ] as const;

  const pieData = useMemo(
    () =>
      statusItems.map((item) => ({
        type: item.label,
        key: item.key,
        value: item.value,
        pct: item.pct,
      })),
    [statusItems],
  );

  const personChartWidth = Math.max(520, props.person7d.length * 72);
  const rangeLabel = props.chartRangeLabel;
  const lineXAlias = props.chartRange === "all" ? "月份" : "日期";

  const summaryCards = [
    { key: "users", title: "用户总数", value: props.tokenCount, color: "#1677ff" },
    { key: "apps", title: "支持的App数量", value: props.appCount, color: "#13c2c2" },
    { key: "docs", title: "迁移文档总数", value: props.migrationDocCount, color: "#2f54eb" },
    { key: "tasks", title: "累计任务", value: props.taskTotalAllTime, color: "#fa8c16" },
  ] as const;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Title level={2} style={{ margin: 0 }}>
        仪表盘
      </Title>
      <Row gutter={[12, 12]} style={{ width: "100%" }}>
        {summaryCards.map((item) => (
          <Col key={item.key} xs={24} sm={12} xl={{ flex: "1 1 0" }} style={{ minWidth: 0 }}>
            <Card className="admin-card" style={{ height: "100%" }}>
              <Space direction="vertical" size={8}>
                <Space size={8} align="center">
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: item.color, display: "inline-block" }} />
                  <span style={{ color: props.isDark ? "#94a3b8" : "#64748b", fontWeight: 500 }}>{item.title}</span>
                </Space>
                <div style={{ fontSize: 36, lineHeight: "40px", fontWeight: 700, color: props.isDark ? "#f8fafc" : "#0f172a" }}>{item.value}</div>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <div style={{ display: "flex", justifyContent: "flex-start", width: "100%", padding: "4px 0 8px" }}>
        <Segmented
          className="admin-overview-range-segmented"
          value={props.chartRange}
          disabled={props.chartLoading}
          onChange={(value) => props.onChartRangeChange(value as OverviewChartRange)}
          options={CHART_RANGE_OPTIONS}
          size="large"
        />
      </div>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card className="admin-card" title={`${rangeLabel}请求任务数`}>
            <Line
              data={props.line7d}
              xField="day"
              yField="count"
              color="#1677ff"
              theme={props.isDark ? "classicDark" : "classic"}
              smooth
              point={{ shapeField: "circle", size: 4 }}
              tooltip={{
                items: [
                  (datum: { day: string; count: number }) => ({
                    name: datum.day,
                    value: String(datum.count),
                  }),
                ],
              }}
              axis={{
                x: {
                  title: false,
                  labelFill: props.isDark ? "#cbd5e1" : "#475569",
                },
                y: {
                  title: false,
                  tickCount: 4,
                  labelFill: props.isDark ? "#cbd5e1" : "#475569",
                  gridStroke: props.isDark ? "rgba(148, 163, 184, 0.24)" : "rgba(148, 163, 184, 0.2)",
                },
              }}
              meta={{ day: { alias: lineXAlias }, count: { alias: "任务数" } }}
              height={220}
            />
          </Card>
          <Card className="admin-card" title={`${rangeLabel}任务状态`} style={{ marginTop: 12 }}>
            <Pie
              data={pieData}
              angleField="value"
              colorField="type"
              radius={0.9}
              theme={props.isDark ? "classicDark" : "classic"}
              legend={{
                position: "top",
                itemLabelFill: props.isDark ? "#e2e8f0" : "#475569",
                itemMarkerFillOpacity: 1,
              }}
              label={{
                text: (d: { value: number }) => String(d.value),
                position: "spider",
                style: {
                  fill: props.isDark ? "#e2e8f0" : "#334155",
                  fontWeight: 600,
                },
              }}
              color={["#52c41a", "#ff4d4f", "#1677ff"]}
              interactions={[{ type: "element-active" }]}
              tooltip={{
                items: [
                  (datum: { type: string; value: number; pct: number }) => ({
                    name: datum.type,
                    value: `${datum.value}（${datum.pct}%）`,
                  }),
                ],
              }}
              height={260}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="admin-card" title={`${rangeLabel}人员使用任务数`}>
            {props.person7d.length ? (
              <div style={{ overflowX: "auto", overflowY: "hidden" }}>
                <div style={{ width: personChartWidth }}>
                  <Column
                    data={props.person7d}
                    xField="person"
                    yField="count"
                    autoFit={false}
                    width={personChartWidth}
                    height={220}
                    colorField="person"
                    theme={props.isDark ? "classicDark" : "classic"}
                    xAxis={{
                      label: {
                        autoRotate: true,
                        autoHide: false,
                        style: { fill: props.isDark ? "#cbd5e1" : "#475569" },
                      },
                    }}
                    yAxis={{
                      min: 0,
                      nice: true,
                      label: { style: { fill: props.isDark ? "#cbd5e1" : "#475569" } },
                      grid: {
                        line: {
                          style: {
                            stroke: props.isDark ? "rgba(148, 163, 184, 0.24)" : "rgba(148, 163, 184, 0.2)",
                          },
                        },
                      },
                    }}
                    meta={{ count: { alias: "任务数" }, person: { alias: "人员" } }}
                    columnStyle={{ radius: [4, 4, 0, 0] }}
                  />
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${rangeLabel}暂无任务数据`} />
            )}
          </Card>
          <Card className="admin-card" title={`${rangeLabel}使用次数人员排行`} style={{ marginTop: 12 }}>
            <PersonRankChart isDark={props.isDark} items={props.personRank} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
