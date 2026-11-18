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
import { trackMcpToolCall } from '../../kb-telemetry/adapters/mcp-middleware.mjs'
import { flush } from '../../kb-telemetry/client/index.mjs'
import { assertKbProject, assertPlatform } from './open-session.mjs'

const L2_TOOLS = {
  kb_codegraph_search: kbCodegraphSearch,
  kb_codegraph_explore: kbCodegraphExplore,
  kb_codegraph_node: kbCodegraphNode,
  kb_codegraph_callers: kbCodegraphCallers,
  kb_codegraph_callees: kbCodegraphCallees,
  kb_codegraph_impact: kbCodegraphImpact,
  kb_codegraph_files: kbCodegraphFiles,
  kb_codegraph_status: kbCodegraphStatus,
}

function telemetryOpts(session, env = process.env) {
  return {
    env,
    consumer: env.KB_TELEMETRY_CONSUMER || 'kb-mcp-for-codegraph',
    apiTokenId: session.tokenId,
    personCode: session.personCode,
    personName: session.personName,
    mcpSessionId: session.mcpSessionId || null,
    traceId: session.mcpSessionId || null,
  }
}

function scheduleTelemetryFlush(env = process.env) {
  void flush({ env }).catch((e) => {
    console.warn('[kb-mcp-for-codegraph] telemetry flush failed:', e instanceof Error ? e.message : e)
  })
}

function withCodegraphArgs(session, args) {
  const projectId = assertKbProject(session, args.project_id)
  const platform = assertPlatform(args.platform)
  return { ...args, project_id: projectId, platform }
}

export async function handleCodegraphTool(name, args, session, env = process.env) {
  const fn = L2_TOOLS[name]
  if (!fn) throw new Error(`unknown tool: ${name}`)

  const scoped = withCodegraphArgs(session, args)
  const tel = telemetryOpts(session, env)
  const started = Date.now()
  const result = await fn(scoped)
  await trackMcpToolCall(name, scoped, result, { ...tel, latencyMs: Date.now() - started })
  scheduleTelemetryFlush(env)
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
}
