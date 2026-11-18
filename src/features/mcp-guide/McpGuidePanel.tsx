"use client";

import { CopyOutlined } from "@ant-design/icons";
import { Button, Typography, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { buildCursorMcpConfigJson } from "./build-mcp-config";
import { copyTextToClipboard } from "@/lib/copy-to-clipboard";
import styles from "./McpGuidePanel.module.css";

const { Title, Paragraph } = Typography;

const MCP_CAPABILITIES = [
  {
    name: "文档知识库",
    desc: "迁移文档检索与分段阅读，快速理解页面业务与接口。",
    tone: "doc",
  },
  {
    name: "代码图谱",
    desc: "类/方法检索、调用链、影响面分析，减少全仓 grep 与无效上下文。",
    tone: "graph",
  },
  {
    name: "受控源码",
    desc: "在 Token 授权 App Scope 内精读 Android 源码，权限与 Web AI 员工一致。",
    tone: "source",
  },
] as const;

export function McpGuidePanel() {
  const [token, setToken] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");

  useEffect(() => {
    setToken(localStorage.getItem("hm_token") || "");
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/kb-mcp/v1/endpoint", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { mcpUrl?: string };
        if (active && typeof data.mcpUrl === "string") setMcpUrl(data.mcpUrl);
      } catch {
        // fall back to build-time default in buildCursorMcpConfigJson
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const configJson = useMemo(
    () => (token ? buildCursorMcpConfigJson(token, mcpUrl || undefined) : ""),
    [token, mcpUrl],
  );

  async function copyText(content: string) {
    if (!content) return;
    const ok = await copyTextToClipboard(content);
    if (ok) {
      message.success("MCP 配置已复制");
      return;
    }
    message.error("复制失败，请手动选中上方配置复制");
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title level={3} className={styles.title}>
          驻场 MCP 接入
        </Title>
        <Paragraph className={styles.lead}>
          面向本地 Agent（Cursor 等）的 HTTP MCP 网关，使用工台 Token 鉴权，在授权 App Scope 内提供三层能力：
          <span className={styles.leadCaps}>文档知识库、代码图谱、受控源码</span>。
        </Paragraph>
      </div>

      <section className={styles.section}>
        <Title level={5} className={styles.sectionTitle}>
          能做什么
        </Title>
        <div className={styles.toolGrid}>
          {MCP_CAPABILITIES.map((item) => (
            <div
              key={item.name}
              className={`${styles.toolCard} ${styles[`toolCard_${item.tone}`]}`}
            >
              <div className={`${styles.toolName} ${styles[`toolName_${item.tone}`]}`}>{item.name}</div>
              <div className={styles.toolDesc}>{item.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <Title level={5} className={styles.sectionTitle}>
          Agent 配置
        </Title>
        <Paragraph type="secondary" className={styles.configHint}>
          粘贴到 Cursor/Codex/CC/CodeGenie 等 Agent 的 MCP 配置（已填入你的 Token）：
        </Paragraph>
        <div className={styles.configBlock}>
          <pre className={styles.configPre}>{configJson || "（登录后显示配置）"}</pre>
          <div className={styles.copyRow}>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              disabled={!configJson}
              onClick={() => void copyText(configJson)}
            >
              复制配置
            </Button>
          </div>
        </div>
      </section>

      <p className={styles.notice}>
        请注意：所有 MCP 工具调用均会记录审计，请勿滥用 Token 或超出授权范围访问源码与知识库。
      </p>
    </div>
  );
}
