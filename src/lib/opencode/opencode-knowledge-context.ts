import { resolveKnowledgeFeatureContext } from 'android-harmony-kb/knowledge-runtime'
import { trackKbContextServed, trackKbMatchAttempt } from '../kb-telemetry-bridge'
import { resolveKbProjectIdFromAppScope } from '../kb-project-labels'
import { buildKbMissDirective } from './opencode-code-facts'
import { extractUrlPathGrepHints } from '../ktv-url-lookup'

type OpencodeClassRef = {
  fqn: string
  module?: string
}

type ManifestKnowledgeContext = {
  hit: boolean
  feature_id?: string
  match_by?: string
  feature?: {
    title?: string
    summary?: string
    breadcrumb?: string[]
  }
  overview?: { doc_ref?: string; section?: string | null; content?: string; truncated?: boolean } | null
  documents?: Array<{ doc_ref?: string; section?: string | null; content?: string; truncated?: boolean }>
  retrieval?: { strategy?: string; route_shards?: string[]; read_refs?: string[] }
  platforms?: {
    android?: { symbols?: Array<{ class_fqn?: string | null; symbol?: string | null }>; code_map_refs?: string[] }
    harmonyos?: { symbols?: Array<{ class_fqn?: string | null; symbol?: string | null }>; code_map_refs?: string[] }
  }
  citations?: Array<{ source_id?: string; doc_ref?: string }>
  cross_platform_ready?: boolean
}

const FQN_RE = /(?:^|[\s(@])((?:[A-Za-z_][\w$]*\.){2,}[A-Za-z_][\w$]*)(?=[#\s,，。;；:：!?？)]|$)/g
const SIMPLE_CLASS_RE = /(?:^|[\s(@])([A-Z][A-Za-z0-9_]{2,})(?=[\s,.，。;；:：!?？)]|$)/g
const FEATURE_ID_RE = /\b([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]+){2,})\b/g
const SYMBOL_REF_RE = /((?:[A-Za-z_][\w$]*\.){2,}[A-Za-z_][\w$]*#[A-Za-z_$][\w$]*(?:\([^\r\n)]*\))?)/g
const KNOWLEDGE_DOC_REF_RE = /(wiki\/features\/[^\r\n）)】》'"`]+?\.md(?:#[^\r\n）)】》'"`]+)?)/gu

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
}

function extractClassHintsFromMessage(message: string) {
  const fqns = [...String(message || '').matchAll(FQN_RE)]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean)
  if (fqns.length) return uniqueStrings(fqns)
  return uniqueStrings(
    [...String(message || '').matchAll(SIMPLE_CLASS_RE)]
      .map((match) => String(match[1] || '').trim())
      .filter((name) => name && !['OpenCode', 'Android', 'Harmony'].includes(name)),
  )
}

function extractFeatureIdHintsFromMessage(message: string) {
  const classHints = extractClassHintsFromMessage(message)
  return uniqueStrings(
    [...String(message || '').matchAll(FEATURE_ID_RE)]
      .map((match) => String(match[1] || '').trim())
      .filter((hint) => !classHints.some((classHint) => classHint === hint || classHint.startsWith(`${hint}.`)))
      .filter(Boolean),
  )
}

function extractSymbolHintsFromMessage(message: string) {
  return uniqueStrings(
    [...String(message || '').matchAll(SYMBOL_REF_RE)]
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean),
  )
}

function extractKnowledgeDocRefsFromMessage(message: string) {
  const normalized = String(message || '').replace(/\\/g, '/')
  return uniqueStrings(
    [...normalized.matchAll(KNOWLEDGE_DOC_REF_RE)]
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean),
  )
}

function hasExactClassSymbol(context: ManifestKnowledgeContext, classHints: string[]) {
  if (!classHints.length) return true
  const symbols = [
    ...(context.platforms?.android?.symbols || []),
    ...(context.platforms?.harmonyos?.symbols || []),
  ]
  return classHints.some((hint) => {
    const normalized = hint.trim()
    const simple = normalized.includes('.') ? normalized.split('.').pop() : normalized
    return symbols.some((item) => {
      const fqn = String(item.class_fqn || '').trim()
      const symbol = String(item.symbol || '').trim()
      return fqn === normalized || symbol === normalized || (!normalized.includes('.') && (fqn.endsWith(`.${simple}`) || symbol === simple))
    })
  })
}

function formatManifestKnowledgeContext(context: ManifestKnowledgeContext) {
  const android = context.platforms?.android
  const harmony = context.platforms?.harmonyos
  const androidSymbols = (android?.symbols || [])
    .slice(0, 4)
    .map((item) => item.symbol || item.class_fqn)
    .filter(Boolean)
  const harmonySymbols = (harmony?.symbols || [])
    .slice(0, 4)
    .map((item) => item.symbol || item.class_fqn)
    .filter(Boolean)
  const citations = (context.citations || [])
    .map((item) => item.doc_ref)
    .filter((item): item is string => Boolean(item))
    .slice(0, 6)
  const lines = [
    '[工台知识库上下文 · L1 业务知识]',
    `feature_id: ${context.feature_id || 'unknown'}`,
    `功能: ${context.feature?.title || context.feature_id || 'unknown'}`,
    `业务摘要: ${context.feature?.summary || '（无摘要）'}`,
  ]
  if (context.feature?.breadcrumb?.length) lines.push(`功能路径: ${context.feature.breadcrumb.join(' / ')}`)
  if (androidSymbols.length) lines.push(`Android 登记锚点: ${androidSymbols.join(', ')}`)
  if (harmonySymbols.length) lines.push(`Harmony 登记锚点: ${harmonySymbols.join(', ')}`)
  if (android?.code_map_refs?.length) lines.push(`Android code_map: ${android.code_map_refs.slice(0, 3).join(', ')}`)
  if (harmony?.code_map_refs?.length) lines.push(`Harmony code_map: ${harmony.code_map_refs.slice(0, 3).join(', ')}`)
  const documents = context.documents?.length ? context.documents : context.overview ? [context.overview] : []
  let remaining = 8000
  for (const document of documents) {
    if (!document.content || remaining <= 0) continue
    const content = document.content.slice(0, remaining)
    lines.push(`\n精确路由内容${document.doc_ref ? `（${document.doc_ref}）` : ''}:\n${content}`)
    remaining -= content.length
  }
  if (citations.length) lines.push(`\n引用: ${citations.join(', ')}`)
  lines.push(
    `检索: ${context.retrieval?.strategy || 'manifest_route'}；仅加载 route shard: ${(context.retrieval?.route_shards || []).join(', ') || 'none'}`,
    '本轮 L1 已由工台完成索引定位和精确章节读取，禁止重复调用 kb_knowledge_search / kb_knowledge_read。',
    '仅当用户明确询问调用方、被调用方、影响面，或上述精确章节不足时，才下沉 L2 CodeGraph；普通类职责说明直接基于本上下文作答。',
    '说明: 当前项目绑定的 Manifest 知识源提供 L1 业务事实与双端代码地图；最终事实核验才进入 L3 scoped source。\n',
  )
  return `${lines.join('\n')}\n`
}

export type OpencodeKnowledgeMeta = {
  hit: boolean
  feature_id?: string
  match_by?: string
  match_candidates?: string[]
  artifacts?: string[]
  inject_chars?: number
  intent?: string
  inject_mode?: 'full'
  retrieval_mode?: 'kb_pack'
  read_refs?: string[]
  code_map_refs?: string[]
  cross_platform_ready?: boolean
  error?: string
}

export type OpencodeKnowledgeContextOptions = {
  appScopeId?: string
  projectId?: string
  harmonyWorkspaceAlias?: string
}

export async function buildOpencodeKnowledgeDirective(
  message: string,
  classRefs: OpencodeClassRef[] = [],
  telemetry?: { chatSessionId?: string; apiTokenId?: string },
  contextOptions?: OpencodeKnowledgeContextOptions,
): Promise<string> {
  const bundle = await buildOpencodeKnowledgeBundle(message, classRefs, telemetry, contextOptions)
  return bundle.directive
}

export async function buildOpencodeKnowledgeBundle(
  message: string,
  classRefs: OpencodeClassRef[] = [],
  telemetry?: { chatSessionId?: string; apiTokenId?: string },
  contextOptions?: OpencodeKnowledgeContextOptions,
): Promise<{ directive: string; meta: OpencodeKnowledgeMeta }> {
  const projectId = contextOptions?.projectId || resolveKbProjectIdFromAppScope(contextOptions?.appScopeId)
  const classHints = uniqueStrings([
    ...classRefs.map((item) => item.fqn),
    ...extractClassHintsFromMessage(message),
  ])
  const hints = uniqueStrings([
    ...extractSymbolHintsFromMessage(message),
    ...classHints,
    ...extractFeatureIdHintsFromMessage(message),
  ])
  const docRefs = extractKnowledgeDocRefsFromMessage(message)

  try {
    let context = resolveKnowledgeFeatureContext({
      project_id: projectId,
      query: message,
      hints,
      doc_refs: docRefs,
      min_score: 300,
      max_content_chars: 4000,
    }) as ManifestKnowledgeContext

    // A portal document question already identifies the feature. Pull both code maps into
    // the same L1 pack so the Agent can verify dual-end entry points without broad L2 scans.
    if (context.hit && context.match_by === 'doc_ref' && docRefs.length) {
      const codeMapRefs = uniqueStrings([
        ...(context.platforms?.android?.code_map_refs || []),
        ...(context.platforms?.harmonyos?.code_map_refs || []),
      ])
      if (codeMapRefs.length) {
        const expanded = resolveKnowledgeFeatureContext({
          project_id: projectId,
          feature_id: context.feature_id,
          query: message,
          hints,
          doc_refs: uniqueStrings([...docRefs, ...codeMapRefs]),
          max_content_chars: 8000,
        }) as ManifestKnowledgeContext
        if (expanded.hit) {
          context = {
            ...expanded,
            match_by: context.match_by,
            retrieval: {
              ...expanded.retrieval,
              strategy: 'manifest_exact_route',
            },
          }
        }
      }
    }
    const isInexactClassSymbolMatch =
      context.hit && context.match_by === 'symbol' && classHints.length > 0 && !hasExactClassSymbol(context, classHints)
    if (context.hit && !isInexactClassSymbolMatch) {
      const directive = formatManifestKnowledgeContext(context)
      const artifacts = (context.citations || [])
        .map((item) => item.doc_ref)
        .filter((item): item is string => Boolean(item))
      const meta: OpencodeKnowledgeMeta = {
        hit: true,
        feature_id: context.feature_id,
        match_by: `knowledge:${context.match_by || 'query'}`,
        match_candidates: hints,
        artifacts,
        inject_chars: directive.length,
        intent: 'business_context',
        inject_mode: 'full',
        retrieval_mode: 'kb_pack',
        read_refs: context.retrieval?.read_refs || [],
        code_map_refs: uniqueStrings([
          ...(context.platforms?.android?.code_map_refs || []),
          ...(context.platforms?.harmonyos?.code_map_refs || []),
        ]),
        cross_platform_ready: Boolean(context.cross_platform_ready),
      }
      await trackKbContextServed(meta, telemetry || {})
      await trackKbMatchAttempt({
        hit: true,
        feature_id: context.feature_id,
        match_by: meta.match_by,
        match_candidates: hints,
      }, telemetry || {})
      return { directive, meta }
    }
  } catch (error) {
    // A pluggable source failure is a miss; the Agent continues with L2/L3.
    const reason = error instanceof Error ? error.message : String(error)
    await trackKbMatchAttempt({ hit: false, match_candidates: hints }, telemetry || {})
    return {
      directive: buildKbMissDirective([...extractUrlPathGrepHints(message), ...hints.slice(0, 4)]),
      meta: { hit: false, match_candidates: hints, error: reason },
    }
  }

  await trackKbMatchAttempt({ hit: false, match_candidates: hints }, telemetry || {})
  return {
    directive: buildKbMissDirective([...extractUrlPathGrepHints(message), ...hints.slice(0, 4)]),
    meta: { hit: false, match_candidates: hints },
  }
}
