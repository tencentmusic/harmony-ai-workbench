/**
 * Feature Context Pack 构建（stdio MCP 与 Gateway 共用）
 */
import { TOOL_ROUTING_HINT } from './mcp-tool-copy.mjs'
import { resolveKnowledgeFeatureContext } from './knowledge-source-runtime.mjs'

function buildRecommendedTools(context, surface) {
  const next = []
  const firstRoute = context.routes.find((route) => route.read.length > 0)
  if (firstRoute) {
    next.push({
      tool: 'kb_knowledge_read',
      args: {
        project_id: context.project_id,
        source_id: context.source_id,
        feature_id: context.feature_id,
        ...(firstRoute.intent ? { intent: firstRoute.intent } : {}),
      },
      reason: 'Read the routed business knowledge before source analysis.',
    })
  }
  for (const platform of ['android', 'harmonyos']) {
    const symbol = context.platforms[platform].symbols[0]
    if (!symbol || (surface === 'gateway' && platform === 'harmonyos')) continue
    next.push({
      tool: 'kb_codegraph_search',
      args: {
        project_id: context.project_id,
        query: symbol.class_fqn || symbol.symbol || symbol.simple_name,
        platform,
      },
      reason: `Validate the ${platform} code-map anchor against the current CodeGraph index.`,
    })
  }
  return {
    routing_hints: TOOL_ROUTING_HINT,
    next_tools: next,
    do_not: [
      'Do not scan the whole repository before reading the routed business knowledge.',
      'Treat CodeGraph as a rebuildable L2 index and source code as the final L3 evidence.',
    ],
  }
}

function buildContextPack(context, { requestedFeatureId, surface }) {
  const overview = context.overview?.content || ''
  const pack = {
    schema_version: '1.1',
    kind: 'feature_context_pack',
    project_id: context.project_id,
    feature_id: context.feature_id,
    requested_feature_id: requestedFeatureId,
    title: context.feature.title,
    surface,
    primary_source: context.source_id,
    source_strategy: 'manifest_only',
    facts: {
      business_summary: context.feature.summary,
      breadcrumb: context.feature.breadcrumb,
      applies_to: context.feature.applies_to,
      overview_excerpt: overview.slice(0, 6000),
      routes: context.routes,
    },
    mappings: {
      source: `${context.source_id}_code_map`,
      android: context.platforms.android,
      harmonyos: context.platforms.harmonyos,
      cross_platform_ready: context.cross_platform_ready,
    },
    recommended_tools: buildRecommendedTools(context, surface),
    uncertainties: [],
    citations: context.citations.map((citation) => `${citation.source_id}:${citation.doc_ref}`),
  }
  return pack
}

/**
 * L1 is sourced from the project's configured manifest knowledge source. Missing knowledge is reported and
 * must fall through to L2/L3; old relation or mapping stores are never read.
 */
export function buildFeatureContextPack({
  feature_id,
  project_id = 'demo-project',
  surface = 'stdio',
  env = process.env,
  config,
}) {
  let knowledge
  try {
    knowledge = resolveKnowledgeFeatureContext({
      project_id,
      feature_id,
      max_content_chars: 8000,
    }, { env, config })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  if (!knowledge.hit) {
    return { error: `feature not found: ${project_id}/${feature_id}` }
  }

  return buildContextPack(knowledge, {
    requestedFeatureId: feature_id,
    surface,
  })
}
