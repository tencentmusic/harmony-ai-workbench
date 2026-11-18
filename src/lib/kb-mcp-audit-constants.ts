/** 下拉筛选项（不含历史 consumer 名） */
export const MCP_AUDIT_CONSUMERS = ["kb-mcp-for-zc", "kb-mcp-for-codegraph", "opencode-mcp"] as const;

/** 默认查询范围：含 Gateway 改名前的 remote-mcp 历史数据 */
export const MCP_AUDIT_QUERY_CONSUMERS = [
  "kb-mcp-for-zc",
  "kb-mcp-for-codegraph",
  "remote-mcp",
  "opencode-mcp",
] as const;

/** 驻场 Gateway 相关 consumer（统计卡片合并展示） */
export const MCP_ZC_CONSUMERS = ["kb-mcp-for-zc", "remote-mcp"] as const;

/** 下拉「驻场 MCP」应对应查询的 consumer 集合（含历史 remote-mcp） */
export function resolveMcpAuditConsumerFilter(consumer?: string | null): readonly string[] {
  const key = String(consumer || "").trim();
  if (!key) return MCP_AUDIT_QUERY_CONSUMERS;
  if (key === "kb-mcp-for-zc") return MCP_ZC_CONSUMERS;
  if (key === "kb-mcp-for-codegraph") return ["kb-mcp-for-codegraph"];
  if (key === "opencode-mcp") return ["opencode-mcp"];
  return [key];
}

export const MCP_CONSUMER_LABELS: Record<string, string> = {
  "kb-mcp-for-zc": "驻场 MCP",
  // 与 kb-mcp-for-zc 同一 Gateway；DB 里早期进程上报为 remote-mcp
  "remote-mcp": "驻场 MCP",
  "kb-mcp-for-codegraph": "CodeGraph MCP",
  "opencode-mcp": "OpenCode MCP",
};
