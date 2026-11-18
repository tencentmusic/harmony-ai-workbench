/**
 * MCP 工具 description 文案 + tools/list schema 构建
 */
export const WIKI_DOC_SCOPE_NOTE =
  'Doc scope: android-migration = external Git-backed Android→Harmony migration cases (NOT Harmony source). For Harmony .ets use kb_codegraph_*(platform=harmonyos). Future harmony-native docs use doc_scope=harmony-native.'

export const GATEWAY_SCOPE_NOTE =
  'Remote kb-mcp-for-zc: Android L2/L3 only. No harmonyos CodeGraph / no .ets read. Wiki = migration docs; kb_resolve_counterpart for Harmony metadata only.'

export const STDIO_SCOPE_NOTE =
  'Local harmony-kb-mcp: Android + Harmony CodeGraph. Wiki = external migration cases only — not .java/.ets source.'

export const TOOL_ROUTING_HINT = {
  l1_business_and_code_map: 'get_feature_context (project knowledge source) → kb_knowledge_read(exact routed doc_ref)',
  migration_doc: 'kb_wiki_search → kb_wiki_read(nav→harmony-section|section)',
  android_source: 'get_feature_context → kb_codegraph_* → (gateway: kb_source_*)',
  harmony_source: 'kb_resolve_counterpart → kb_codegraph_*(harmonyos) → read .ets locally',
  cross_platform: 'get_feature_context + kb_resolve_counterpart + kb_codegraph BOTH platforms',
}

const L2_ANDROID_GATEWAY =
  'MANDATORY before kb_source_read/grep. Android CodeGraph only on gateway. Returns locations/graph — then callers/callees/impact.'

const L2_BOTH_STDIO =
  'MANDATORY before read/glob on android-src or harmony-src. Use platform=android OR harmonyos (both for cross-platform). Then callers/callees/impact.'

export const CODEGRAPH_GATEWAY_SCOPE_NOTE =
  'kb-mcp-for-codegraph: Android + Harmony CodeGraph only. No source read — use the authorized local workspace for .java/.ets files. Calls are reported to workbench telemetry.'

export const TOOL_DESCRIPTIONS = {
  kb_knowledge_sources: {
    stdio:
      '[L1 · pluggable knowledge] List manifest knowledge sources available to a project, including readiness and target coverage.',
    gateway:
      '[L1 · authenticated pluggable knowledge] List document knowledge sources allowed by the token project scope.',
  },
  kb_knowledge_search: {
    stdio:
      '[L1 · business knowledge] Search feature ownership, business rules, code maps and registered symbols. Search first, then read the selected feature or exact doc_ref.',
    gateway:
      '[L1 · authenticated business knowledge] Search project-scoped knowledge manifests. Results never cross the token project scope.',
  },
  kb_knowledge_read: {
    stdio:
      '[L1 · progressive read] Read a compact feature overview, then exact routed Markdown sections. Do not read unrelated documents or repeat a Workbench-injected L1 lookup.',
    gateway:
      '[L1 · authenticated progressive read] Read only project-scoped feature pages and exact routed sections.',
  },
  get_feature_context: {
    stdio:
      '[L1 · business knowledge] Context Pack for a feature_id. Returns business facts and Android/Harmony code-map references. Missing coverage falls through to L2/L3; no legacy mapping fallback.',
    gateway:
      `[L1 · business knowledge] Project-scoped Context Pack with no legacy mapping fallback. Includes recommended_tools before kb_source_*. ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_resolve_counterpart: {
    stdio:
      '[L1 · business knowledge] Android↔Harmony counterpart lookup from routed code maps and symbols. Missing coverage falls through to L2/L3; no legacy relation fallback.',
    gateway: `[L1 · business knowledge] Harmony code-map metadata from the project knowledge source (Android-first remote). ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_wiki_search: {
    stdio: `[L1 · migration index] Git-backed migration case search. ${WIKI_DOC_SCOPE_NOTE} Workflow: search → kb_wiki_read(nav). NOT for .java/.ets.`,
    gateway: `[L1 · migration index] ${WIKI_DOC_SCOPE_NOTE} ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_wiki_read: {
    stdio: `[L1 · progressive read] nav|section|harmony-section|detail|children. ${WIKI_DOC_SCOPE_NOTE} harmony-section = 鸿蒙落地相关 ## only.`,
    gateway: `[L1 · progressive read] Same modes as stdio (except no .ets). ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_codegraph_explore: {
    stdio: `[L2 · PRIMARY when feature_id unknown] ${L2_BOTH_STDIO}`,
    gateway: `[L2 · PRIMARY explore] ${L2_ANDROID_GATEWAY}`,
    codegraph_gateway: `[L2 · explore] ${L2_BOTH_STDIO} ${CODEGRAPH_GATEWAY_SCOPE_NOTE}`,
  },
  kb_codegraph_search: {
    stdio: `[L2] Symbol search (locations only). ${L2_BOTH_STDIO}`,
    gateway: `[L2] Android symbol search. ${L2_ANDROID_GATEWAY}`,
    codegraph_gateway: `[L2] Symbol search. ${L2_BOTH_STDIO} ${CODEGRAPH_GATEWAY_SCOPE_NOTE}`,
  },
  kb_codegraph_callers: {
    stdio: '[L2] Callers of symbol. After search. Required before claiming call-chain facts.',
    gateway: '[L2] Android callers. After kb_codegraph_search/explore.',
    codegraph_gateway: '[L2] Callers of symbol (android or harmonyos).',
  },
  kb_codegraph_callees: {
    stdio: '[L2] Callees of symbol. Downstream dependencies.',
    gateway: '[L2] Android callees.',
    codegraph_gateway: '[L2] Callees of symbol (android or harmonyos).',
  },
  kb_codegraph_impact: {
    stdio: '[L2] Refactor impact surface. Before large changes.',
    gateway: '[L2] Android impact analysis.',
    codegraph_gateway: '[L2] Refactor impact (android or harmonyos).',
  },
  kb_codegraph_node: {
    stdio: '[L2] Single symbol node detail when search returns many hits.',
    gateway: '[L2] Android node detail.',
    codegraph_gateway: '[L2] Single symbol node detail.',
  },
  kb_codegraph_files: {
    stdio: '[L2] Indexed module file tree. Requires module_rel.',
    gateway: '[L2] Android module file tree.',
    codegraph_gateway: '[L2] Indexed module file tree. Requires module_rel.',
  },
  kb_codegraph_status: {
    stdio: '[L2] CodeGraph index health. Use when L2 returns empty/errors.',
    gateway: '[L2] Android index status.',
    codegraph_gateway: `[L2] Index health for android/harmonyos modules. ${CODEGRAPH_GATEWAY_SCOPE_NOTE}`,
  },
  kb_source_grep: {
    gateway: `[L3] Server-side Android grep. ONLY after L2 in session (soft warning if skipped). ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_source_read: {
    gateway: `[L3] Read Android source slice (~512KB max). ONLY after kb_codegraph_* (soft warning if skipped). ${GATEWAY_SCOPE_NOTE}`,
  },
  kb_source_fetch_drawable: {
    gateway: '[L3] List drawable assets in token scope. UI migration.',
  },
}

export const PROJECT_ID_PROP = {
  project_id: {
    type: 'string',
    description: 'Registered project identifier from the active workspace configuration. Default demo-project.',
    default: 'demo-project',
  },
}

export const GATEWAY_PROJECT_ID_PROP = {
  project_id: {
    type: 'string',
    description: 'Registered project identifier from the active workspace configuration. Must match token scope.',
    default: 'demo-project',
  },
}

const PLATFORM_PROP = {
  platform: {
    type: 'string',
    enum: ['android', 'harmonyos'],
    default: 'android',
    description: 'android = Java/Kotlin index; harmonyos = .ets index (stdio only)',
  },
}

const WIKI_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    source_id: { type: 'string', description: 'Optional migration knowledge source id. Defaults to the first configured portal source.' },
    query: {
      type: 'string',
      description: 'Chinese title, feature topic, Android class, or Harmony entry/route',
    },
    doc_scope: {
      type: 'string',
      enum: ['android-migration', 'harmony-native'],
      default: 'android-migration',
    },
    limit: { type: 'number', default: 8 },
  },
  required: ['query'],
}

const WIKI_READ_SCHEMA = {
  type: 'object',
  properties: {
    source_id: { type: 'string', description: 'Source id returned by kb_wiki_search.' },
    doc_id: { type: 'string' },
    feature_id: { type: 'string' },
    doc_ref: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['nav', 'section', 'harmony-section', 'detail', 'children'],
      default: 'nav',
      description: 'harmony-section = 鸿蒙落地/对照相关 ## 章节聚合',
    },
    section: { type: 'string', description: 'Required when mode=section' },
    child_ref: { type: 'string' },
  },
}

/** @param {'stdio'|'gateway'} surface */
export function buildMcpToolList(surface) {
  const pid = surface === 'gateway' ? GATEWAY_PROJECT_ID_PROP : PROJECT_ID_PROP
  const d = TOOL_DESCRIPTIONS
  const wikiSearch = { ...WIKI_SEARCH_SCHEMA, properties: { ...WIKI_SEARCH_SCHEMA.properties, ...pid } }
  const wikiRead = { ...WIKI_READ_SCHEMA, properties: { ...WIKI_READ_SCHEMA.properties, ...pid } }

  const tools = [
    {
      name: 'kb_knowledge_sources',
      description: d.kb_knowledge_sources[surface],
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Optional knowledge source id configured for the project.' },
          ...pid,
        },
      },
    },
    {
      name: 'kb_knowledge_search',
      description: d.kb_knowledge_search[surface],
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Optional; omitted when the project has one default Manifest knowledge source.' },
          query: { type: 'string', description: 'Business phrase, feature title, feature_id, exact wiki/features/*.md path, class name, FQN or FQN#member.' },
          target: {
            type: 'string',
            description: 'Optional configured target such as kugou_live.android or kugou_live.harmony.',
          },
          limit: { type: 'number', default: 5 },
          ...pid,
        },
        required: ['query'],
      },
    },
    {
      name: 'kb_knowledge_read',
      description: d.kb_knowledge_read[surface],
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Optional; omitted when the project has one default Manifest knowledge source.' },
          feature_id: { type: 'string', description: 'Feature returned by kb_knowledge_search.' },
          doc_ref: { type: 'string', description: 'Exact read reference returned by a feature route.' },
          target: {
            type: 'string',
            description: 'Optional configured target such as kugou_live.android or kugou_live.harmony.',
          },
          intent: { type: 'string', description: 'Optional route intent filter when reading a feature.' },
          max_content_chars: {
            type: 'number',
            default: 6000,
            description: 'Content budget. Keep small; prefer exact doc_ref sections over whole feature pages.',
          },
          ...pid,
        },
      },
    },
    {
      name: 'get_feature_context',
      description: d.get_feature_context[surface],
      inputSchema: {
        type: 'object',
        properties: {
          feature_id: { type: 'string', description: 'Feature id from the configured business knowledge source, e.g. abs_star' },
          ...pid,
        },
        required: ['feature_id'],
      },
    },
    {
      name: 'kb_resolve_counterpart',
      description: d.kb_resolve_counterpart[surface],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          from_platform:
            surface === 'gateway'
              ? { type: 'string', enum: ['android'], default: 'android' }
              : { type: 'string', enum: ['android', 'harmonyos'], default: 'android' },
          feature_id: { type: 'string' },
          ...pid,
        },
      },
    },
    {
      name: 'kb_codegraph_explore',
      description: d.kb_codegraph_explore[surface],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          limit: { type: 'number', default: 6 },
          ...pid,
        },
        required: ['query'],
      },
    },
    {
      name: 'kb_codegraph_search',
      description: d.kb_codegraph_search[surface],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          limit: { type: 'number', default: 8 },
          ...pid,
        },
        required: ['query'],
      },
    },
    {
      name: 'kb_codegraph_callers',
      description: d.kb_codegraph_callers[surface],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          limit: { type: 'number', default: 30 },
          ...pid,
        },
        required: ['symbol'],
      },
    },
    {
      name: 'kb_codegraph_callees',
      description: d.kb_codegraph_callees[surface],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          limit: { type: 'number', default: 30 },
          ...pid,
        },
        required: ['symbol'],
      },
    },
    {
      name: 'kb_codegraph_impact',
      description: d.kb_codegraph_impact[surface],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          depth: { type: 'number', default: 2 },
          limit: { type: 'number', default: 40 },
          ...pid,
        },
        required: ['symbol'],
      },
    },
    {
      name: 'kb_codegraph_node',
      description: d.kb_codegraph_node[surface],
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          ...pid,
        },
        required: ['target'],
      },
    },
    {
      name: 'kb_codegraph_files',
      description: d.kb_codegraph_files[surface],
      inputSchema: {
        type: 'object',
        properties: {
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          pattern: { type: 'string' },
          max_depth: { type: 'number', default: 4 },
          ...pid,
        },
        required: ['module_rel'],
      },
    },
    {
      name: 'kb_codegraph_status',
      description: d.kb_codegraph_status[surface],
      inputSchema: {
        type: 'object',
        properties: {
          ...(surface === 'stdio' ? PLATFORM_PROP : {}),
          module_rel: { type: 'string' },
          ...pid,
        },
      },
    },
    {
      name: 'kb_wiki_search',
      description: d.kb_wiki_search[surface],
      inputSchema: wikiSearch,
    },
    {
      name: 'kb_wiki_read',
      description: d.kb_wiki_read[surface],
      inputSchema: wikiRead,
    },
  ]

  if (surface === 'gateway') {
    tools.push(
      {
        name: 'kb_source_grep',
        description: d.kb_source_grep.gateway,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path_prefix: { type: 'string' },
            ...pid,
          },
          required: ['pattern'],
        },
      },
      {
        name: 'kb_source_read',
        description: d.kb_source_read.gateway,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'android-src/... or feature/... under scope' },
            offset: { type: 'number', default: 1 },
            limit: { type: 'number', default: 200 },
          },
          required: ['path'],
        },
      },
      {
        name: 'kb_source_fetch_drawable',
        description: d.kb_source_fetch_drawable.gateway,
        inputSchema: {
          type: 'object',
          properties: {
            resource_name: { type: 'string' },
            name_prefix: { type: 'string' },
            limit: { type: 'number', default: 20 },
            ...pid,
          },
        },
      },
    )
  }

  return tools
}

/** kb-mcp-for-codegraph：仅 L2 CodeGraph，Android + Harmony，无鉴权 */
export function buildCodegraphGatewayToolList() {
  const pid = PROJECT_ID_PROP
  const d = TOOL_DESCRIPTIONS
  const withPlatform = (schema) => ({
    ...schema,
    properties: { ...schema.properties, ...PLATFORM_PROP },
  })
  const baseExplore = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      module_rel: { type: 'string' },
      limit: { type: 'number', default: 20 },
      ...pid,
    },
    required: ['query'],
  }
  const names = [
    'kb_codegraph_explore',
    'kb_codegraph_search',
    'kb_codegraph_callers',
    'kb_codegraph_callees',
    'kb_codegraph_impact',
    'kb_codegraph_node',
    'kb_codegraph_files',
    'kb_codegraph_status',
  ]
  return names.map((name) => {
    const stdioTool = buildMcpToolList('stdio').find((t) => t.name === name)
    return {
      name,
      description: d[name].codegraph_gateway || d[name].stdio,
      inputSchema: withPlatform(stdioTool?.inputSchema || baseExplore),
    }
  })
}

// legacy exports
export const KB_WIKI_SEARCH_DESC = TOOL_DESCRIPTIONS.kb_wiki_search.stdio
export const KB_WIKI_READ_DESC = TOOL_DESCRIPTIONS.kb_wiki_read.stdio
