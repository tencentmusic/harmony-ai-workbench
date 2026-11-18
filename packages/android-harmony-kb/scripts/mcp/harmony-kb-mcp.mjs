#!/usr/bin/env node
/**
 * android-harmony-kb-mcp — 统一知识库 MCP（Cursor / Codex / OpenCode 共用）
 *
 * 覆盖：Android 单端开发、Harmony 单端开发、Android↔Harmony 跨端迁移。
 * L2 CodeGraph 工具对标官方 codegraph_search/callers/impact，作用域为 KB 已索引 module。
 *
 * Tools:
 *   kb_knowledge_sources    — 可插拔文档知识源清单
 *   kb_knowledge_search     — 外部业务知识检索
 *   kb_knowledge_read       — feature / 精确章节读取
 *   get_feature_context     — L1 业务知识 Context Pack
 *   kb_codegraph_search     — L2 符号搜索（locations only）
 *   kb_codegraph_explore    — L2 主入口探索（对齐官方 explore）
 *   kb_codegraph_node       — L2 节点详情
 *   kb_codegraph_callers    — L2 调用方
 *   kb_codegraph_callees    — L2 被调方
 *   kb_codegraph_impact     — L2 影响面
 *   kb_codegraph_files      — L2 模块文件树
 *   kb_codegraph_status     — L2 索引状态
 *   kb_resolve_counterpart  — L1 双端 code_map 查询
 *   kb_wiki_search          — L1 迁移文档意图索引（先搜后读，禁止全库 grep）
 *   kb_wiki_read            — L1 迁移文档渐进式读取（nav / section / detail）
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  kbCodegraphCallers,
  kbCodegraphCallees,
  kbCodegraphExplore,
  kbCodegraphFiles,
  kbCodegraphImpact,
  kbCodegraphNode,
  kbCodegraphSearch,
  kbCodegraphStatus,
} from '../lib/codegraph-runtime.mjs'
import { resolveCounterpart } from '../lib/cross-platform-resolve.mjs'
import { kbWikiRead, kbWikiSearch } from '../lib/migration-wiki.mjs'
import { buildMcpToolList } from '../lib/mcp-tool-copy.mjs'
import { buildFeatureContextPack } from '../lib/feature-context-pack.mjs'
import {
  listKnowledgeSources,
  readKnowledge,
  searchKnowledge,
} from '../lib/knowledge-source-runtime.mjs'
import { trackMcpContextServed, trackMcpToolCall } from '../../packages/kb-telemetry/adapters/mcp-middleware.mjs'
import { flush } from '../../packages/kb-telemetry/client/index.mjs'
import { resolveTelemetryTrace } from '../../packages/kb-telemetry/lib/resolve-telemetry-trace.mjs'

function mcpTelemetryOpts(req) {
  const meta = req.params?._meta && typeof req.params._meta === 'object' ? req.params._meta : {}
  const hostSessionId = String(
    meta.sessionID ||
      meta.sessionId ||
      meta.opencodeSessionId ||
      meta.hostSessionId ||
      '',
  ).trim()
  const bound = resolveTelemetryTrace({
    env: process.env,
    consumer: process.env.KB_TELEMETRY_CONSUMER || 'mcp-direct',
    hostSessionId: hostSessionId || undefined,
  })
  return {
    env: process.env,
    consumer: process.env.KB_TELEMETRY_CONSUMER || 'mcp-direct',
    ...(bound
      ? {
          traceId: bound.traceId,
          turnId: bound.turnId,
          featureId: bound.featureId || undefined,
          apiTokenId: bound.apiTokenId || undefined,
        }
      : {}),
  }
}

async function runTrackedTool(name, args, run, telemetryOpts) {
  const started = Date.now()
  const result = await run(args)
  await trackMcpToolCall(name, args, result, {
    ...telemetryOpts,
    latencyMs: Date.now() - started,
  })
  return result
}

const TOOLS = buildMcpToolList('stdio')

const server = new Server({ name: 'android-harmony-kb-mcp', version: '0.10.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = req.params.arguments || {}
  const telemetryOpts = mcpTelemetryOpts(req)

  const knowledgeTools = {
    kb_knowledge_sources: listKnowledgeSources,
    kb_knowledge_search: searchKnowledge,
    kb_knowledge_read: readKnowledge,
  }
  if (knowledgeTools[name]) {
    const result = await runTrackedTool(
      name,
      args,
      (value) => knowledgeTools[name](value, { env: process.env }),
      telemetryOpts,
    )
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'get_feature_context') {
    const pack = buildFeatureContextPack({
      ...args,
      surface: 'stdio',
      env: process.env,
    })
    await trackMcpContextServed(args, pack, { ...telemetryOpts, toolName: 'get_feature_context' })
    void flush({ env: process.env }).catch(() => {})
    return { content: [{ type: 'text', text: toSimpleYaml(pack) }] }
  }

  if (name === 'kb_resolve_counterpart') {
    const result = await runTrackedTool(name, args, (a) => resolveCounterpart({ ...a, env: process.env }), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_explore') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphExplore(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_node') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphNode(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_callees') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphCallees(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_files') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphFiles(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_status') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphStatus(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_search') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphSearch(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_callers') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphCallers(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_codegraph_impact') {
    const result = await runTrackedTool(name, args, (a) => kbCodegraphImpact(a), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_wiki_search') {
    const result = await runTrackedTool(name, args, (a) => kbWikiSearch(a, process.env), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_wiki_read') {
    const result = await runTrackedTool(name, args, (a) => kbWikiRead(a, process.env), telemetryOpts)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

function toSimpleYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  if (obj === null || obj === undefined) return `${pad}null\n`
  if (typeof obj !== 'object') {
    const v = typeof obj === 'string' ? JSON.stringify(obj) : String(obj)
    return `${pad}${v}\n`
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => `${pad}- ${formatYamlValue(item, indent + 1)}`).join('\n') + (obj.length ? '\n' : '')
  }
  let out = ''
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out += `${pad}${k}:\n${toSimpleYaml(v, indent + 1)}`
    } else if (Array.isArray(v)) {
      out += `${pad}${k}:\n${toSimpleYaml(v, indent + 1)}`
    } else {
      out += `${pad}${k}: ${formatYamlValue(v, indent)}\n`
    }
  }
  return out
}

function formatYamlValue(v, indent) {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return `\n${toSimpleYaml(v, indent + 1).trimEnd()}`
    return `\n${toSimpleYaml(v, indent + 1).trimEnd()}`
  }
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
