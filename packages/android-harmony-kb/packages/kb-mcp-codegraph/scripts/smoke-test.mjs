#!/usr/bin/env node
/**
 * 本地 smoke test：health + MCP tools/list + kb_codegraph_status（无需 token）
 *
 *   npm run mcp:codegraph:test
 */
import { loadCodegraphEnv } from '../lib/load-env.mjs'

loadCodegraphEnv()

const gatewayUrl = String(
  process.env.KB_MCP_CODEGRAPH_URL || process.env.KB_MCP_GATEWAY_URL || 'http://127.0.0.1:8421',
).replace(/\/+$/, '')

async function mcpRequest(method, params = {}) {
  const res = await fetch(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`mcp_${res.status}:${text.slice(0, 300)}`)
  }
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
  if (dataLine) return JSON.parse(dataLine.slice(6))
  return JSON.parse(text)
}

async function main() {
  console.log('1) Gateway health...')
  const health = await fetch(`${gatewayUrl}/health`).then((r) => r.json())
  console.log('   ', health)

  console.log('2) MCP initialize + tools/list...')
  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.1.0' },
  })
  const listed = await mcpRequest('tools/list', {})
  const tools = listed.result?.tools || []
  console.log('   tools:', tools.map((t) => t.name).join(', '))
  if (tools.length !== 8) {
    throw new Error(`expected 8 tools, got ${tools.length}`)
  }

  console.log('3) kb_codegraph_status (android, kugou-music)...')
  const called = await mcpRequest('tools/call', {
    name: 'kb_codegraph_status',
    arguments: { project_id: 'kugou-music', platform: 'android' },
  })
  const preview = JSON.stringify(called.result?.content?.[0]?.text || called).slice(0, 400)
  console.log('   ', preview)

  console.log('4) kb_codegraph_status (harmonyos, kugou-live)...')
  const harmony = await mcpRequest('tools/call', {
    name: 'kb_codegraph_status',
    arguments: { project_id: 'kugou-live', platform: 'harmonyos' },
  })
  const preview2 = JSON.stringify(harmony.result?.content?.[0]?.text || harmony).slice(0, 200)
  console.log('   ', preview2)

  console.log('\nSmoke test OK')
}

main().catch((e) => {
  console.error('Smoke test failed:', e.message || e)
  process.exit(1)
})
