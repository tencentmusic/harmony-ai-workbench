#!/usr/bin/env node
/**
 * kb-mcp-for-codegraph — 开放 HTTP MCP（仅 L2 CodeGraph，Android + Harmony，无鉴权）
 *
 * 环境变量见 packages/kb-mcp-codegraph/.env.example
 *   开发: cp .env.example .env.local && npm run mcp:codegraph
 *   生产: cp .env.production.example .env.production && npm run mcp:codegraph:prod
 */
import crypto from 'crypto'
import { loadCodegraphEnv } from './lib/load-env.mjs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { handleCodegraphTool } from './lib/handlers.mjs'
import { CODEGRAPH_TOOLS } from './lib/tools.mjs'
import { CODEGRAPH_BUILD_ID } from './lib/build-info.mjs'
import { buildOpenSession, getOrCreateOpenMcpSession } from './lib/open-session.mjs'

const MCP_SERVICE_NAME = 'kb-mcp-for-codegraph'

const envInfo = loadCodegraphEnv()

const PORT = Number(process.env.KB_MCP_CODEGRAPH_PORT || process.env.KB_MCP_PORT || 8421)
const HOST = String(process.env.KB_MCP_CODEGRAPH_HOST || process.env.KB_MCP_HOST || '127.0.0.1').trim()
const MCP_SERVER_CACHE_TTL_MS = Number(process.env.KB_MCP_SERVER_CACHE_TTL_MS || 4 * 60 * 60 * 1000)
const MCP_SERVER_CACHE_MAX = Number(process.env.KB_MCP_SERVER_CACHE_MAX || 64)
const MCP_SERVER_CACHE = new Map()

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim()
  const ip = forwarded || req.socket?.remoteAddress || 'unknown'
  const ua = String(req.headers['user-agent'] || '')
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24)
}

function evictOldestMcpServer() {
  if (MCP_SERVER_CACHE.size < MCP_SERVER_CACHE_MAX) return
  let oldestKey = null
  let oldestAt = Infinity
  for (const [key, entry] of MCP_SERVER_CACHE) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at
      oldestKey = key
    }
  }
  if (!oldestKey) return
  const entry = MCP_SERVER_CACHE.get(oldestKey)
  try {
    entry?.server?.close?.()
  } catch {
    /* ignore */
  }
  MCP_SERVER_CACHE.delete(oldestKey)
}

function getOrCreateCachedMcpServer(session, cacheKey) {
  const now = Date.now()
  const hit = MCP_SERVER_CACHE.get(cacheKey)
  if (hit && now - hit.at < MCP_SERVER_CACHE_TTL_MS) {
    hit.at = now
    hit.ctx.session = session
    return hit.server
  }
  if (hit) {
    try {
      hit.server?.close?.()
    } catch {
      /* ignore */
    }
    MCP_SERVER_CACHE.delete(cacheKey)
  }
  evictOldestMcpServer()
  const ctx = { session }
  const server = createMcpServer(ctx)
  MCP_SERVER_CACHE.set(cacheKey, { server, ctx, at: now })
  return server
}

function createMcpServer(ctx) {
  const server = new Server(
    { name: MCP_SERVICE_NAME, version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CODEGRAPH_TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = req.params.arguments || {}
    try {
      return await handleCodegraphTool(name, args, ctx.session, process.env)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }],
        isError: true,
      }
    }
  })

  return server
}

const app = createMcpExpressApp({ host: HOST })

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: MCP_SERVICE_NAME,
    build_id: CODEGRAPH_BUILD_ID,
    workbench: process.env.WORKBENCH_URL || process.env.WORKBENCH_PUBLIC_URL || 'http://127.0.0.1:3100',
    tools: CODEGRAPH_TOOLS.length,
  })
})

app.post('/mcp', async (req, res) => {
  const key = clientKey(req)
  const mcpSessionId = getOrCreateOpenMcpSession(key)
  const session = { ...buildOpenSession(), mcpSessionId }
  res.setHeader('X-KB-MCP-Session-Id', mcpSessionId)

  let server = getOrCreateCachedMcpServer(session, key)
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => {
      transport.close()
    })
  } catch (error) {
    MCP_SERVER_CACHE.delete(key)
    console.error('MCP request error:', error)
    if (!res.headersSent) {
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        server = createMcpServer({ session })
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        res.on('close', () => transport.close())
        return
      } catch (retryError) {
        console.error('MCP retry error:', retryError)
      }
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST /mcp' },
    id: null,
  })
})

app.listen(PORT, HOST, () => {
  console.log(`${MCP_SERVICE_NAME} listening on http://${HOST}:${PORT}`)
  console.log(`  env mode: ${envInfo.mode}${envInfo.loaded.length ? ` (${envInfo.loaded.join(' → ')})` : ''}`)
  console.log(`  workbench: ${process.env.WORKBENCH_URL || process.env.WORKBENCH_PUBLIC_URL || 'http://127.0.0.1:3100'}`)
  console.log(`  MCP endpoint: POST http://${HOST}:${PORT}/mcp`)
  console.log(`  Health:       GET  http://${HOST}:${PORT}/health`)
})

process.on('SIGINT', () => process.exit(0))
