"use client";

import { Fragment, type ReactNode } from "react";
import { Tooltip } from "antd";
import { ApiOutlined, DeploymentUnitOutlined, ReadOutlined, RobotOutlined, FileZipOutlined, CompressOutlined, SwapOutlined } from "@ant-design/icons";
import styles from "./WorkbenchNav.module.css";

export type WorkbenchTab = "chat" | "knowledge" | "cloud-agent" | "integration" | "mcp" | "package-comparison" | "image-compression";

type NavItem = {
  key: WorkbenchTab;
  icon: ReactNode;
  label: string;
  hint?: string;
};

type Props = {
  current: WorkbenchTab;
  onChange: (tab: WorkbenchTab) => void;
};

const groups: NavItem[][] = [
  [
    { key: "knowledge", icon: <ReadOutlined />, label: "知识库" },
    { key: "chat", icon: <RobotOutlined />, label: "AI员工" },
    { key: "cloud-agent", icon: <SwapOutlined />, label: "转译台" },
    { key: "integration", icon: <DeploymentUnitOutlined />, label: "集成台" },
  ],
  [
    { key: "package-comparison", icon: <FileZipOutlined />, label: "包体", hint: "包体对比" },
    { key: "image-compression", icon: <CompressOutlined />, label: "图片", hint: "图片压缩" },
    { key: "mcp", icon: <ApiOutlined />, label: "MCP" },
  ],
];

export function WorkbenchNav(props: Props) {
  return (
    <div className={styles.navWrap}>
      {groups.map((items, index) => (
        <Fragment key={items[0].key}>
          {index > 0 ? <div className={styles.navDivider} role="separator" /> : null}
          <div className={styles.navGroup}>
            {items.map((item) => {
              const selected = item.key === props.current;
              const button = (
                <button
                  key={item.key}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  aria-label={item.hint ?? item.label}
                  className={`${styles.navButton} ${selected ? styles.navButtonActive : ""}`}
                  onClick={() => props.onChange(item.key)}
                >
                  <span className={styles.navItem}>
                    <span className={styles.navIcon}>{item.icon}</span>
                    <span className={styles.navText}>{item.label}</span>
                  </span>
                </button>
              );
              return item.hint ? (
                <Tooltip key={item.key} id={`workbench-nav-${item.key}`} title={item.hint} placement="right">
                  {button}
                </Tooltip>
              ) : button;
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
