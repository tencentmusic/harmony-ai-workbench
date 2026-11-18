import { NextResponse } from 'next/server'

/** MCP 接入页展示用 Gateway 地址（运行时读取，避免仅 build 时写死 127.0.0.1） */
export async function GET() {
  const base =
    process.env.KB_MCP_PUBLIC_URL?.trim() ||
    process.env.NEXT_PUBLIC_KB_MCP_URL?.trim() ||
    'http://127.0.0.1:8420'
  const normalized = base.replace(/\/+$/, '')
  return NextResponse.json({
    baseUrl: normalized,
    mcpUrl: `${normalized}/mcp`,
  })
}
