import {
  kbCodegraphCallers,
  kbCodegraphCallees,
  kbCodegraphExplore,
  kbCodegraphFiles,
  kbCodegraphImpact,
  kbCodegraphNode,
  kbCodegraphSearch,
  kbCodegraphStatus,
} from '../../../scripts/lib/codegraph-runtime.mjs'
import { resolveCounterpart } from '../../../scripts/lib/cross-platform-resolve.mjs'
import { kbWikiRead, kbWikiSearch } from '../../../scripts/lib/migration-wiki.mjs'
import { buildFeatureContextPack } from '../../../scripts/lib/feature-context-pack.mjs'
import {
  listKnowledgeSources,
  readKnowledge,
  searchKnowledge,
} from '../../../scripts/lib/knowledge-source-runtime.mjs'
import { trackMcpContextServed, trackMcpToolCall } from '../../kb-telemetry/adapters/mcp-middleware.mjs'
import { flush } from '../../kb-telemetry/client/index.mjs'
import {
  assertAndroidPlatform,
  assertKbProject,
  assertModuleInScope,
} from './scope-guard.mjs'
import { fetchDrawable, sourceGrep, sourceRead } from './l3-source.mjs'
import { attachL3Warning, markSessionL2 } from './session-l2-tracker.mjs'

const CONTEXT_PACK_CACHE = new Map()
const CONTEXT_PACK_CACHE_MS = Number(process.env.KB_MCP_CONTEXT_PACK_CACHE_MS || 60000)

function buildContextPackCached({ feature_id, project_id = 'demo-project' }, env = process.env) {
  const key = `${project_id}:${feature_id}`
  const now = Date.now()
  const hit = CONTEXT_PACK_CACHE.get(key)
  if (hit && now - hit.at < CONTEXT_PACK_CACHE_MS) return hit.pack
  const pack = buildFeatureContextPack({
    feature_id,
    project_id,
    surface: 'gateway',
    env,
  })
  if (!pack.error) CONTEXT_PACK_CACHE.set(key, { pack, at: now })
  return pack
}

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

function telemetryOpts(session, env = process.env) {
  return {
    env,
    consumer: env.KB_TELEMETRY_CONSUMER || 'kb-mcp-for-zc',
    apiTokenId: session.tokenId,
    personCode: session.personCode,
    personName: session.personName,
    mcpSessionId: session.mcpSessionId || null,
    traceId: session.mcpSessionId || null,
  }
}

/** 异步 flush，不阻塞工具响应（client 内已有 batch/debounce） */
function scheduleTelemetryFlush(env = process.env) {
  void flush({ env }).catch((e) => {
    console.warn('[kb-mcp-for-zc] telemetry flush failed:', e instanceof Error ? e.message : e)
  })
}

function withAndroidArgs(session, args) {
  const projectId = assertKbProject(session, args.project_id)
  if (args.platform) assertAndroidPlatform(args.platform)
  if (args.module_rel) assertModuleInScope(session, projectId, args.module_rel)
  return { ...args, project_id: projectId, platform: 'android' }
}

export async function handleGatewayTool(name, args, session, env = process.env) {
  const tel = telemetryOpts(session, env)

  const knowledgeTools = {
    kb_knowledge_sources: listKnowledgeSources,
    kb_knowledge_search: searchKnowledge,
    kb_knowledge_read: readKnowledge,
  }
  if (knowledgeTools[name]) {
    const projectId = assertKbProject(session, args.project_id)
    const scoped = { ...args, project_id: projectId }
    const started = Date.now()
    const result = knowledgeTools[name](scoped, { env })
    await trackMcpToolCall(name, scoped, result, { ...tel, latencyMs: Date.now() - started })
    scheduleTelemetryFlush(env)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'get_feature_context') {
    const projectId = assertKbProject(session, args.project_id)
    const pack = buildContextPackCached({ ...args, project_id: projectId }, env)
    await trackMcpContextServed({ ...args, project_id: projectId }, pack, { ...tel, toolName: name })
    scheduleTelemetryFlush(env)
    return { content: [{ type: 'text', text: toSimpleYaml(pack) }] }
  }

  if (name === 'kb_resolve_counterpart') {
    if (args.from_platform) assertAndroidPlatform(args.from_platform)
    const projectId = assertKbProject(session, args.project_id)
    const started = Date.now()
    const result = await resolveCounterpart({ ...args, project_id: projectId, env })
    await trackMcpToolCall(name, args, result, { ...tel, latencyMs: Date.now() - started })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  const l2Tools = {
    kb_codegraph_search: kbCodegraphSearch,
    kb_codegraph_explore: kbCodegraphExplore,
    kb_codegraph_node: kbCodegraphNode,
    kb_codegraph_callers: kbCodegraphCallers,
    kb_codegraph_callees: kbCodegraphCallees,
    kb_codegraph_impact: kbCodegraphImpact,
    kb_codegraph_files: kbCodegraphFiles,
    kb_codegraph_status: kbCodegraphStatus,
  }
  if (l2Tools[name]) {
    const scoped = withAndroidArgs(session, args)
    const started = Date.now()
    const result = await l2Tools[name](scoped)
    markSessionL2(session, name)
    await trackMcpToolCall(name, scoped, result, { ...tel, latencyMs: Date.now() - started })
    scheduleTelemetryFlush(env)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_wiki_search' || name === 'kb_wiki_read') {
    const projectId = assertKbProject(session, args.project_id)
    const started = Date.now()
    const fn = name === 'kb_wiki_search' ? kbWikiSearch : kbWikiRead
    const result = fn({ ...args, project_id: projectId }, env)
    await trackMcpToolCall(name, args, result, { ...tel, latencyMs: Date.now() - started })
    scheduleTelemetryFlush(env)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_source_grep') {
    const projectId = assertKbProject(session, args.project_id)
    const started = Date.now()
    let result = sourceGrep(session, { ...args, project_id: projectId }, env)
    result = attachL3Warning(result, name, session)
    await trackMcpToolCall(name, args, result, { ...tel, latencyMs: Date.now() - started })
    scheduleTelemetryFlush(env)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_source_read') {
    const started = Date.now()
    let result = sourceRead(session, args, env)
    result = attachL3Warning(result, name, session)
    await trackMcpToolCall(name, args, result, { ...tel, latencyMs: Date.now() - started })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'kb_source_fetch_drawable') {
    const projectId = assertKbProject(session, args.project_id)
    const started = Date.now()
    const result = fetchDrawable(session, { ...args, project_id: projectId }, env)
    await trackMcpToolCall(name, args, result, { ...tel, latencyMs: Date.now() - started })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
}
