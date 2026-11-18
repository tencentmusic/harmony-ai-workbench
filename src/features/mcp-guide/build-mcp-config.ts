import { getKbMcpGatewayMcpUrl } from '@/lib/kb-mcp-public-url'

export function buildCursorMcpConfig(token: string, mcpUrl?: string) {
  return {
    mcpServers: {
      'kb-mcp-for-zc': {
        url: mcpUrl?.trim() || getKbMcpGatewayMcpUrl(),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }
}

export function buildCursorMcpConfigJson(token: string, mcpUrl?: string): string {
  return `${JSON.stringify(buildCursorMcpConfig(token, mcpUrl), null, 2)}\n`
}
