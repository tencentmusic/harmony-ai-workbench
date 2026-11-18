#!/usr/bin/env node
/**
 * 本地 smoke test：introspect + MCP tools/list + kb_codegraph_status
 *
 * 读取 packages/kb-mcp-gateway/.env.local（与 server 相同规则）
 *   KB_MCP_TEST_TOKEN=hm_xxx npm run mcp:gateway:test
 */
import { loadGatewayEnv } from '../lib/load-env.mjs'
import { fetchIntrospect, workbenchBaseUrl } from '../lib/auth.mjs'
import { buildSession } from '../lib/scope-guard.mjs'

loadGatewayEnv()

const token = String(process.env.KB_MCP_TEST_TOKEN || '').trim()
const gatewayUrl = String(process.env.KB_MCP_GATEWAY_URL || 'http://127.0.0.1:8420').replace(/\/+$/, '')

if (!token) {
  console.error('Set KB_MCP_TEST_TOKEN=hm_... to run smoke test')
  process.exit(1)
}

async function mcpRequest(method, params = {}) {
  const res = await fetch(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
  console.log('1) Workbench introspect via gateway auth helper...')
  console.log('   workbench:', workbenchBaseUrl())
  const intro = await fetchIntrospect(token)
  const session = buildSession(intro)
  console.log('   tokenId:', intro.tokenId)
  console.log('   scopes:', session.prefixEntries.length, 'prefix entries')
  console.log('   kb projects:', session.allowedKbProjectIds.join(', '))

  console.log('2) Gateway health...')
  const health = await fetch(`${gatewayUrl}/health`).then((r) => r.json())
  console.log('   ', health)

  console.log('3) MCP initialize + tools/list...')
  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.1.0' },
  })
  const listed = await mcpRequest('tools/list', {})
  const tools = listed.result?.tools || []
  console.log('   tools:', tools.map((t) => t.name).join(', '))

  console.log('4) kb_codegraph_status (android)...')
  const called = await mcpRequest('tools/call', {
    name: 'kb_codegraph_status',
    arguments: { project_id: session.allowedKbProjectIds[0] || 'kugou-music' },
  })
  const preview = JSON.stringify(called.result?.content?.[0]?.text || called).slice(0, 400)
  console.log('   ', preview)

  console.log('\nSmoke test OK')
}

main().catch((e) => {
  console.error('Smoke test failed:', e.message || e)
  process.exit(1)
})
