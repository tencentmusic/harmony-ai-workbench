"use client";

import { useMemo } from "react";
import { Empty, Progress, Typography } from "antd";
import styles from "./PersonRankChart.module.css";

const BAR_COLORS = [
  "#1677ff",
  "#13c2c2",
  "#8c8c8c",
  "#722ed1",
  "#52c41a",
  "#2f54eb",
  "#ff4d4f",
  "#fa8c16",
  "#eb2f96",
  "#597ef7",
] as const;

type Props = {
  isDark: boolean;
  items: Array<{ person: string; count: number }>;
};

type RankItem = {
  key: string;
  person: string;
  count: number;
  sharePct: number;
  barPct: number;
  color: string;
};

export function PersonRankChart(props: Props) {
  const rows = useMemo<RankItem[]>(() => {
    const sorted = [...props.items].sort((a, b) => b.count - a.count || a.person.localeCompare(b.person, "zh-CN"));
    const totalCount = sorted.reduce((sum, row) => sum + row.count, 0) || 1;
    const maxCount = sorted[0]?.count || 1;
    return sorted.map((row, idx) => ({
      key: row.person,
      person: row.person,
      count: row.count,
      sharePct: Math.round((row.count / totalCount) * 1000) / 10,
      barPct: Math.max(4, Math.round((row.count / maxCount) * 100)),
      color: BAR_COLORS[idx % BAR_COLORS.length],
    }));
  }, [props.items]);

  if (!rows.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无累计使用数据" />;
  }

  const subtitleColor = props.isDark ? "#94a3b8" : "#64748b";
  const nameColor = props.isDark ? "#f1f5f9" : "#0f172a";
  const trackColor = props.isDark ? "rgba(148, 163, 184, 0.18)" : "#eef2f7";

  return (
    <div className={styles.root}>
      <Typography.Text className={styles.subtitle} style={{ color: subtitleColor }}>
        每位人员的累计任务次数及占全部任务的比例
      </Typography.Text>
      {rows.map((row) => (
        <div key={row.key} className={styles.row}>
          <div className={styles.rowHead}>
            <span className={styles.name} style={{ color: nameColor }} title={row.person}>
              {row.person}
            </span>
            <span className={styles.meta} style={{ color: subtitleColor }}>
              {row.count} 次 · {row.sharePct}%
            </span>
          </div>
          <Progress
            className={styles.bar}
            percent={row.barPct}
            showInfo={false}
            strokeColor={row.color}
            trailColor={trackColor}
            size={10}
          />
        </div>
      ))}
    </div>
  );
}
