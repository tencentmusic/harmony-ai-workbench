/** 驻场 HTTP MCP Gateway 基址（不含 /mcp 路径）。生产可在 .env.production 设 NEXT_PUBLIC_KB_MCP_URL。 */
export function getKbMcpGatewayBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_KB_MCP_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  return 'http://127.0.0.1:8420'
}

export function getKbMcpGatewayMcpUrl(): string {
  return `${getKbMcpGatewayBaseUrl()}/mcp`
}
