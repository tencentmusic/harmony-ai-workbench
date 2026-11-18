import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listWorkspaceLinks, loadWorkspaceConfig } from '@kugou/workspace-config'

const START_DIR = path.dirname(fileURLToPath(import.meta.url))

const BUCKET_RULES = [
  { bucket: 'harmony-kb', patterns: [/harmony-kb/i, /android-harmony-kb/i, /android_wiki/i, /wiki\/features\//i, /knowledge\//i] },
  { bucket: 'harmony-docs', patterns: [/harmony-docs/i, /migration\//i] },
  {
    bucket: 'harmony-src',
    patterns: [/harmony-src/i, /\.ets$/i, /feature\//i],
  },
  {
    bucket: 'android-src',
    patterns: [/android-src/i, /\.java$/i, /\.kt$/i],
  },
  {
    bucket: 'android-src',
    patterns: [/source-src/i],
  },
]

const CODEGRAPH_TOOL_NAMES = new Set([
  'kb_codegraph_search',
  'kb_codegraph_explore',
  'kb_codegraph_node',
  'kb_codegraph_callers',
  'kb_codegraph_callees',
  'kb_codegraph_impact',
  'kb_codegraph_files',
  'kb_codegraph_status',
  'codegraph_search',
  'codegraph_context',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_explore',
  'codegraph_node',
  'codegraph_files',
  'codegraph_status',
])

const FEATURE_CONTEXT_TOOLS = new Set(['get_feature_context', 'kb_resolve_feature', 'kb_resolve_counterpart'])
const DOCUMENT_KNOWLEDGE_TOOLS = new Set([
  'kb_knowledge_sources',
  'kb_knowledge_search',
  'kb_knowledge_read',
  'kb_wiki_search',
  'kb_wiki_read',
])

/** OpenCode 会把 MCP 工具记成 android-harmony-kb-mcp_kb_codegraph_search；统计/分类用 canonical 名。 */
export function canonicalAgentToolName(toolName) {
  const raw = String(toolName || '').trim()
  if (!raw) return raw
  if (/^(harmony-kb|android-harmony-kb)/i.test(raw)) {
    const sep = raw.indexOf('_')
    if (sep > 0 && sep < raw.length - 1) return raw.slice(sep + 1)
  }
  return raw
}

export function classifyArtifactPath(rawPath, env = process.env) {
  const normalized = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!normalized) return { path_bucket: 'other', artifact_path: '' }

  let rel = normalized
  try {
    const links = listWorkspaceLinks(loadWorkspaceConfig({ startDir: START_DIR, env }))
      .map((link) => ({ ...link, normalizedRoot: link.root.replace(/\\/g, '/').replace(/\/+$/, '') }))
      .sort((a, b) => b.normalizedRoot.length - a.normalizedRoot.length)
    const link = links.find((item) => normalized === item.normalizedRoot || normalized.startsWith(`${item.normalizedRoot}/`))
    if (link) rel = `${link.alias}/${normalized.slice(link.normalizedRoot.length).replace(/^\/+/, '')}`
  } catch {
    // 缺少 Workbench 配置时保留模式分类能力。
  }

  for (const rule of BUCKET_RULES) {
    if (rule.patterns.some((re) => re.test(normalized) || re.test(rel))) {
      return { path_bucket: rule.bucket, artifact_path: rel || normalized }
    }
  }
  return { path_bucket: 'other', artifact_path: rel || normalized }
}

export function classifyToolName(toolName) {
  const name = String(toolName || '').toLowerCase()
  if (name.includes('grep') || name.includes('search')) return 'grep'
  if (name.includes('glob') || name.includes('list')) return 'glob'
  if (name.includes('read')) return 'read'
  return 'other'
}

export function classifyMcpTool(toolName) {
  const name = canonicalAgentToolName(String(toolName || '').trim())
  if (FEATURE_CONTEXT_TOOLS.has(name) || DOCUMENT_KNOWLEDGE_TOOLS.has(name)) {
    return { tool_family: 'feature_context', retrieval_mode: 'kb_pack', delivery: 'mcp_tool' }
  }
  if (CODEGRAPH_TOOL_NAMES.has(name) || name.startsWith('kb_codegraph_')) {
    return { tool_family: 'codegraph', retrieval_mode: 'codegraph_index', delivery: 'codegraph_mcp' }
  }
  return { tool_family: 'other', retrieval_mode: 'raw_scan', delivery: 'mcp_tool' }
}

export function classifyAgentTool(toolName) {
  const canonical = canonicalAgentToolName(toolName)
  const name = canonical.toLowerCase()
  if (CODEGRAPH_TOOL_NAMES.has(canonical) || name.includes('codegraph')) {
    return { tool_family: 'codegraph', retrieval_mode: 'codegraph_index', delivery: 'codegraph_mcp' }
  }
  const kind = classifyToolName(toolName)
  if (kind === 'grep' || kind === 'glob' || kind === 'read') {
    return { tool_family: 'agent_native', retrieval_mode: 'raw_scan', delivery: 'agent_native' }
  }
  return { tool_family: 'other', retrieval_mode: 'raw_scan', delivery: 'agent_native' }
}

export function substituteLevel(retrievalMode) {
  if (retrievalMode === 'kb_pack') return 'L1'
  if (retrievalMode === 'codegraph_index') return 'L2'
  return 'L3'
}

export function classifyPathBucketMeta(pathBucket) {
  switch (pathBucket) {
    case 'harmony-kb':
      return {
        delivery: 'agent_native',
        retrieval_mode: 'kb_pack',
        tool_family: 'feature_context',
        substitute_level: 'L1',
      }
    case 'harmony-docs':
      return {
        delivery: 'agent_native',
        retrieval_mode: 'kb_pack',
        tool_family: 'feature_context',
        substitute_level: 'L1',
      }
    case 'harmony-src':
      return {
        delivery: 'agent_native',
        retrieval_mode: 'raw_scan',
        tool_family: 'agent_native',
        substitute_level: 'L3',
      }
    case 'android-src':
      return {
        delivery: 'agent_native',
        retrieval_mode: 'raw_scan',
        tool_family: 'agent_native',
        substitute_level: 'L3',
      }
    default:
      return {
        delivery: 'agent_native',
        retrieval_mode: 'raw_scan',
        tool_family: 'other',
        substitute_level: 'L3',
      }
  }
}
