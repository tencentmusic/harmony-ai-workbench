#!/usr/bin/env node
/**
 * kb-mcp-for-zc — 驻场专用远程 HTTP MCP（Streamable HTTP）
 *
 * 环境变量见 packages/kb-mcp-gateway/.env.example
 *   开发: cp .env.example .env.local && npm run mcp:gateway
 *   生产: cp .env.production.example .env.production && npm run mcp:gateway:prod
 */
import crypto from 'crypto'
import { loadGatewayEnv } from './lib/load-env.mjs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { extractTokenFromRequest, fetchIntrospect } from './lib/auth.mjs'
import { buildSession } from './lib/scope-guard.mjs'
import { handleGatewayTool } from './lib/handlers.mjs'
import { GATEWAY_TOOLS } from './lib/tools.mjs'
import { readAsset } from './lib/l3-source.mjs'
import { GATEWAY_BUILD_ID } from './lib/build-info.mjs'
import { getOrCreateMcpSession } from './lib/mcp-session.mjs'

const MCP_SERVICE_NAME = 'kb-mcp-for-zc'

const envInfo = loadGatewayEnv()

const PORT = Number(process.env.KB_MCP_PORT || 8420)
const HOST = String(process.env.KB_MCP_HOST || '127.0.0.1').trim()
const MCP_SERVER_CACHE_TTL_MS = Number(process.env.KB_MCP_SERVER_CACHE_TTL_MS || 4 * 60 * 60 * 1000)
const MCP_SERVER_CACHE_MAX = Number(process.env.KB_MCP_SERVER_CACHE_MAX || 64)
const MCP_SERVER_CACHE = new Map()

function bearerCacheKey(bearer) {
  return crypto.createHash('sha256').update(String(bearer || '')).digest('hex').slice(0, 24)
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

function getOrCreateCachedMcpServer(session, bearerKey) {
  const now = Date.now()
  const hit = MCP_SERVER_CACHE.get(bearerKey)
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
    MCP_SERVER_CACHE.delete(bearerKey)
  }
  evictOldestMcpServer()
  const ctx = { session }
  const server = createMcpServer(ctx)
  MCP_SERVER_CACHE.set(bearerKey, { server, ctx, at: now })
  return server
}

function createMcpServer(ctx) {
  const server = new Server(
    { name: MCP_SERVICE_NAME, version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: GATEWAY_TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = req.params.arguments || {}
    try {
      return await handleGatewayTool(name, args, ctx.session, process.env)
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
    build_id: GATEWAY_BUILD_ID,
    workbench: process.env.WORKBENCH_URL || process.env.WORKBENCH_PUBLIC_URL || 'http://127.0.0.1:3100',
  })
})

app.get('/assets', async (req, res) => {
  const bearer = extractTokenFromRequest(req)
  if (!bearer) return res.status(401).json({ error: 'unauthorized' })
  const assetPath = String(req.query.path || '').trim()
  if (!assetPath) return res.status(400).json({ error: 'path_required' })

  try {
    const introspect = await fetchIntrospect(bearer, process.env)
    const session = buildSession(introspect)
    const { buf, mime, filename } = readAsset(session, assetPath, process.env)
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
    res.send(buf)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg === 'unauthorized' ? 401 : msg.startsWith('path_') || msg.startsWith('not_') ? 403 : 500
    res.status(status).json({ error: msg })
  }
})

app.post('/mcp', async (req, res) => {
  const bearer = extractTokenFromRequest(req)
  if (!bearer) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          'Unauthorized: set Authorization: Bearer hm_xxx (or X-KB-MCP-Token: hm_xxx) in MCP headers',
      },
      id: null,
    })
  }

  let session
  try {
    const introspect = await fetchIntrospect(bearer, process.env)
    const mcpSessionId = getOrCreateMcpSession(bearer)
    session = { ...buildSession(introspect), mcpSessionId }
    res.setHeader('X-KB-MCP-Session-Id', mcpSessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg === 'unauthorized' ? 401 : 503
    return res.status(status).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: msg },
      id: null,
    })
  }

  const cacheKey = bearerCacheKey(bearer)
  let server = getOrCreateCachedMcpServer(session, cacheKey)
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => {
      transport.close()
    })
  } catch (error) {
    MCP_SERVER_CACHE.delete(cacheKey)
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
