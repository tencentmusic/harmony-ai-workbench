/**
 * OpenCode 用户消息意图分类与注入计划（BFF 层，平台强制）。
 *
 * 原则：「搜不搜、注入什么」由平台定；「读完后怎么答」由模型在 AGENTS 约束内自主。
 */
import { shouldUseKtvUrlLookup, isEngineeringFactQuestion } from '../ktv-url-lookup'
import { buildCodeFactsDirective } from './opencode-code-facts'
import { listPortalKnowledgeWorkspaceRoots } from '@/lib/workspace-apps-config'

function migrationKnowledgeRoots() {
  const roots = listPortalKnowledgeWorkspaceRoots('migration')
  return roots.length ? roots.map((root) => `\`${root}/\``).join('、') : '已配置的迁移案例知识库'
}

const ICON_INTENT_RE =
  /(?:原图|图标|icon|drawable|mipmap|webp|png|jpe?g|\.9\.png|资源图|配图|分享.*图|图.*资源|返回.*图|展示.*图|看.*图|所有.*图标|业务.*图标|图标.*业务)/i

function isOpencodeImageIntent(message: string) {
  const text = String(message || '').trim()
  if (!text) return false
  return ICON_INTENT_RE.test(text)
}

const FQN_RE = /(?:^|[\s(@])((?:[A-Za-z_][\w$]*\.){2,}[A-Za-z_][\w$]*)(?=[#\s,，。;；:：!?？)]|$)/g
const SIMPLE_CLASS_RE = /(?:^|[\s(@])([A-Z][A-Za-z0-9_]{2,})(?=[\s,.，。;；:：!?？)]|$)/g

const HARMONY_GENERATE_RE =
  /(?:生成.*鸿蒙|写成.*(?:ArkTS|arkts)|迁移(?:成|为|到)?.*(?:ArkTS|arkts|鸿蒙)|迁移代码|给个鸿蒙实现|帮我写鸿蒙|ArkTS\s*草稿|迁到\s*Harmony)/i

const ANDROID_ANALYZE_RE =
  /(?:分析|调用链|依赖|干什么|迁移点|迁移注意|业务逻辑|解释.*类|@ClassName|\.java|\.kt\b|Fragment|Activity|Delegate|ViewModel)/i

const CONCEPT_ONLY_RE =
  /(?:(?:ArkTS|ArkUI|HarmonyOS|@Component|@State|@Prop|@Link|@Provide|@Consume).*(?:什么是|是什么|怎么用|语法|区别|机制|API))|(?:(?:什么是|解释).*(?:ArkTS|ArkUI|HarmonyOS|@Component|@State|语法|API|机制))|(?:(?:ArkTS|ArkUI|HarmonyOS)\s*(?:语法|API|机制)\s*(?:是什么|怎么用))/i

/** 工台业务题：须查项目源码，不可 docs-only / concept_only */
const WORKBENCH_CODE_QUESTION_RE =
  /(?:接口|configkey|config\s*key|url|path|模块|源码|代码|项目|实现|逻辑|机制|流程|调用|触发|刷新|轮询|下发|拉取|展示|频率|定时|任务|业务|功能|入口|页面|谁调|在哪里|在哪儿|什么时候|怎么写|有没有实现|干什么用|干什么的|查一下|默认\s*url|默认\s*地址)/i

const CAMEL_CASE_TOKEN_RE =
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\bget[A-Z][A-Za-z0-9]+\b|\b[a-z][a-z0-9]*service\b/
const MODULE_PATH_RE = /\b(?:feature|library|app)\/[a-z0-9_.-]+/i

const FRAMEWORK_TOKENS = /\b(?:ArkTS|ArkUI|HarmonyOS|OpenCode)\b/

export function isWorkbenchCodeQuestion(message: string) {
  const text = String(message || '')
  if (CONCEPT_ONLY_RE.test(text)) return false
  if (FRAMEWORK_TOKENS.test(text) && !/(?:接口|configkey|url|源码|代码|类名|fragment|activity|\.java|\.kt\b|live-src|android-src)/i.test(text)) {
    return false
  }
  if (isEngineeringFactQuestion(text)) return true
  if (WORKBENCH_CODE_QUESTION_RE.test(text)) return true
  if (CAMEL_CASE_TOKEN_RE.test(text)) return true
  if (MODULE_PATH_RE.test(text)) return true
  return false
}

const OFF_TOPIC_RE =
  /^(?:你好|您好|hi|hello|谢谢|感谢|在吗|你是谁)[!.?？\s]*$/i

/** 唱/KTV 业务口语（无 @类名 也应注入 harmony-kb） */
const KTV_BUSINESS_RE =
  /唱模块|录歌|录唱|K歌|伴奏|已点|已保存|KTV|K房|kroom|作品发布|调音|排行榜|歌手|我要唱|常见问题|问题反馈|迁移|资产|opus|试听/i

const KTV_COMPARE_RE = /有什么不同|有什么区别|什么差异|有何不同|对比|差别|差异|vs/i

/** 双端对齐 / 鸿蒙实现审计类问题 */
const CROSS_PLATFORM_ANALYZE_RE =
  /鸿蒙|HarmonyOS|Harmony|ArkTS|\.ets\b|双端|对齐|不一致|不一致性|差异|对应|counterpart|harmony-src|harmony-live-src|漏洞/i

/** 鸿蒙工程探索 / 入口页 / 页面类（无 @类名 也应走 L2→grep→read 闭环） */
const HARMONY_EXPLORE_RE =
  /(?:入口|启动|首页|直播间|引导|登录页|页面类|EntryAbility|MainAbility|module\.json5|loadContent|pages\/|能看到|看到.*代码|有哪些.*类|主要.*类|工程根|源码)/i

const CLASS_RELATION_ANALYZE_RE =
  /调用链|调用方|被谁|谁调|上下游|影响面|依赖关系|关联类|引用关系|双端|对端|对应|鸿蒙|Harmony|迁移|架构/i

const ANDROID_CONTEXT_RE = /android|安卓|\.java|\.kt\b|Fragment|Activity|Delegate|ViewModel|live-src|android-src/i

const EXPLICIT_HARMONY_RE = /鸿蒙|HarmonyOS|Harmony|ArkTS|ArkUI|\.ets\b|harmony-src|harmony-live-src/i

const EXPLICIT_DUAL_END_RE =
  /双端|对齐|不一致|对应|counterpart|有没有.*鸿蒙|鸿蒙.*(?:有没有|实现|方式|对应|迁移|侧)|(?:Android|安卓).*(?:鸿蒙|Harmony)|漏洞/i

export type PlatformSearchPlan = {
  androidFirst: boolean
  includeHarmony: boolean
  dualEnd: boolean
}

/** 未指定 Android/鸿蒙端时默认 Android 优先；仅题干明确要求鸿蒙/双端时才查 Harmony */
export function resolvePlatformSearchPlan(message: string): PlatformSearchPlan {
  const text = String(message || '')
  const mentionsHarmony = EXPLICIT_HARMONY_RE.test(text)
  const dualEnd =
    EXPLICIT_DUAL_END_RE.test(text) || (mentionsHarmony && (ANDROID_CONTEXT_RE.test(text) || /[A-Z][A-Za-z0-9_]{2,}Fragment/.test(text)))
  const harmonyOnly =
    mentionsHarmony &&
    !ANDROID_CONTEXT_RE.test(text) &&
    !/[A-Z][A-Za-z0-9_]{2,}(Fragment|Activity)/.test(text) &&
    !EXPLICIT_DUAL_END_RE.test(text)

  return {
    androidFirst: !harmonyOnly,
    includeHarmony: mentionsHarmony || dualEnd,
    dualEnd,
  }
}

const SKIP_CLASS_NAMES = new Set([
  'OpenCode',
  'Android',
  'Harmony',
  'HarmonyOS',
  'ArkTS',
  'ArkUI',
  // ArkUI 装饰器/关键字，避免 concept 题误判为类检索
  'State',
  'Prop',
  'Link',
  'Provide',
  'Consume',
  'Builder',
  'Entry',
  'Component',
  'Observed',
  'Track',
  'Reusable',
  'Extend',
  'Styles',
  'URL',
])

export type OpencodeIntent =
  | 'off_topic'
  | 'concept_only'
  | 'android_analyze'
  | 'harmony_generate'
  | 'asset_url'
  | 'asset_drawable'

/** fallback 优先级：none < docs_only < kb_first < index_scoped < full_scoped */
export type OpencodeFallbackLevel =
  | 'none'
  | 'docs_only'
  | 'kb_first'
  | 'index_scoped'
  | 'full_scoped'

export type OpencodeIntentPlan = {
  intent: OpencodeIntent
  fallbackLevel: OpencodeFallbackLevel
  injectScope: boolean
  injectClassHint: boolean
  injectKnowledge: boolean
  injectUrlDirective: boolean
  injectImageDirective: boolean
  /** 类/双端分析：必须先调 L2 MCP，再允许 read/glob */
  requireL2BeforeRead: boolean
  /** 注入 prompt 开头的 [工台意图] / fallback 说明块 */
  intentDirective: string
}

export function extractClassHintsFromMessage(message: string) {
  const text = String(message || '')
  const fqns: string[] = []
  for (const m of text.matchAll(FQN_RE)) {
    const fqn = String(m[1] || '').trim()
    if (fqn) fqns.push(fqn)
  }
  if (fqns.length) return [...new Set(fqns)]

  const simple: string[] = []
  for (const m of text.matchAll(SIMPLE_CLASS_RE)) {
    const name = String(m[1] || '').trim()
    if (!name || SKIP_CLASS_NAMES.has(name)) continue
    simple.push(name)
  }
  return [...new Set(simple)]
}

export type OpencodeClassRef = {
  fqn: string
  module?: string
}

function shouldRequireL2BeforeRead(
  intent: OpencodeIntent,
  message: string,
  classAnchor: boolean,
): boolean {
  if (intent !== 'android_analyze' && intent !== 'harmony_generate') return false
  return (
    (classAnchor && CLASS_RELATION_ANALYZE_RE.test(message)) ||
    CROSS_PLATFORM_ANALYZE_RE.test(message) ||
    HARMONY_EXPLORE_RE.test(message) ||
    LIVE_APP_HARMONY_RE.test(message)
  )
}

function isHarmonyScopedQuestion(message: string) {
  const text = String(message || '')
  if (CONCEPT_ONLY_RE.test(text)) return false
  return (
    CROSS_PLATFORM_ANALYZE_RE.test(text) ||
    HARMONY_EXPLORE_RE.test(text) ||
    LIVE_APP_HARMONY_RE.test(text)
  )
}

/** 平台强制块：放在 L1/类索引之后，约束 Agent 必须先走 MCP L2 */
export function describeL2GrepFallback(
  primaryClass = '目标类名',
  plan?: PlatformSearchPlan,
  aliases?: { android: string; harmony: string },
) {
  const androidAlias = aliases?.android || 'android-src/live-src'
  const harmonyAlias = aliases?.harmony || 'harmony-src/harmony-live-src'
  const grepAndroid = `→ 在当前 [应用范围] 内 **先 grep**「${primaryClass}」/ FQN / 类简单名（**${androidAlias}**，限定 1–3 个模块）`
  const grepHarmony =
    plan?.includeHarmony
      ? `\n→ Android 主链已清楚且题干含鸿蒙/双端时，再 grep **${harmonyAlias}**（用业务关键词/symbol，**勿**直接用 Android Fragment 类名）`
      : ''
  return [
    '**L2 结果不满意时（必须 fallback grep，不得跳过）**',
    '视为不满意：search/explore 无命中(result_count=0)；status 未索引；callers/callees 无法串主链；counterpart 无对端；返回路径不足以回答题干。',
    `${grepAndroid}${grepHarmony}`,
    '→ grep 仍不足再 scoped glob 定位文件 → read（单轮 glob≤2、grep≤2、read≤4，单文件 read≤200 行）',
    '**禁止** L2 空结果或明显不覆盖时跳过 grep 直接 read，或仅凭 L1/部分 MCP 结果下结论。',
    buildCodeFactsDirective(),
    plan?.androidFirst !== false
      ? '**平台默认**：题干未指定端时，L2/grep/read **默认 Android 优先**；勿因 Harmony 无同名 Fragment 类名判定「L2 不可用」。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** L1 已通过 symbol 或显式知识文档精确路由，普通类分析无需强制 L2。 */
export function isL1RegisteredClassMatch(
  meta?: { hit?: boolean; match_by?: string },
  intent?: OpencodeIntent,
) {
  if (intent !== 'android_analyze') return false
  if (!meta?.hit) return false
  return meta.match_by === 'knowledge:symbol' || meta.match_by === 'knowledge:doc_ref'
}

/** @/FQN 已在 L1 symbol manifest 登记：先基于 L1 作答，L2/read 仅补全验证 */
export function buildL1RegisteredClassDirective(opts: {
  classHints?: string[]
  featureId?: string
  matchBy?: string
  crossPlatform?: boolean
  projectId?: string
  harmonyWorkspaceAlias?: string
  message?: string
  platformPlan?: PlatformSearchPlan
}) {
  const hints = (opts.classHints || []).filter(Boolean).slice(0, 3)
  const primary = hints[0] || '目标类名'
  const projectId = opts.projectId || 'demo-project'
  const harmonyAlias = opts.harmonyWorkspaceAlias || 'harmony-src'
  const androidAlias = 'android-src'
  const plan = opts.platformPlan || resolvePlatformSearchPlan(opts.message || '')
  const includeHarmony = opts.crossPlatform ?? plan.includeHarmony
  const featureId = opts.featureId || '见下方上下文'

  const lines = [
    '[工台 · L1 已登记类 · 作答顺序]',
    `@/FQN 类已在 L1 登记（业务知识优先；feature_id=${featureId}，match=${opts.matchBy || 'class'}）。`,
    '**必须先基于下方 [工台知识库上下文] 主链直接组织答案**（业务逻辑 → 调用链 → 关键依赖 → 迁移注意点）。',
    '**禁止**开场白「先补齐上下游 / 先检索再答 / 等待检索完成」；已注入的 L1 是业务事实主来源。',
    '',
    '**L2 / read 仅作补全或验证**（按需，非答题前置条件）：',
    '- 本轮 L1 已由工台完成，禁止再次调用 kb_knowledge_search / kb_knowledge_read。',
    '- 只有 L1 边标 unresolved、用户明确追问调用方/被调用方/影响面、需 Harmony 对端或源码证据时，才调 kb_codegraph_* / kb_resolve_counterpart。',
    `- 必须查 L2 时：kb_codegraph_search(query="${primary}", limit=5)（project_id=${projectId}，platform=android）；使用已知 module_rel，禁止搜包名前缀或先 explore。`,
    '- 用户只问“是什么/做什么/入口在哪”时，直接依据 L1 作答，不为补全形式调用 callers/callees。',
  ]
  if (includeHarmony) {
    lines.push(
      `- 题干含鸿蒙/双端：先完成 L1 主链 Android 侧作答，再 kb_resolve_counterpart / harmony search（${harmonyAlias}，勿用 Android Fragment 类名）`,
    )
  }
  lines.push(
    `- scoped read ${androidAlias}${includeHarmony ? ` / ${harmonyAlias}` : ''}：**仅当** L1（+ 可选 L2）仍不足以回答时（单文件≤200行）`,
    '',
    describeL2GrepFallback(primary, { ...plan, includeHarmony }, { android: androidAlias, harmony: harmonyAlias }),
    '若 OpenCode 工具列表中看不到 kb_codegraph_*，L1 主链仍可直接作答；需源码时再提示检查 opencode.json / dev:stack。',
    '',
  )
  return `${lines.join('\n')}\n`
}

export function buildSelectedKnowledgeDocumentDirective(opts: {
  docPath: string
  codeMapRefs?: string[]
  crossPlatformReady?: boolean
}) {
  const codeMapRefs = (opts.codeMapRefs || []).filter(Boolean).slice(0, 4)
  const lines = [
    '[工台 · 已选知识文档 · 快速核验]',
    `用户已选中文档：${opts.docPath}。正文和关联代码地图已由工台注入 L1。`,
    '- 核验时可简洁说明当前进度和发现，持续输出；完成后给出有证据的结论。',
    '- 禁止再次调用 kb_knowledge_search / kb_knowledge_read，也禁止为了复述文档调用 CodeGraph。',
  ]
  if (codeMapRefs.length) {
    lines.push(`- 已注入代码地图：${codeMapRefs.join(', ')}`)
  }
  if (opts.crossPlatformReady) {
    lines.push(
      '- 双端入口、调用链和差异优先以已注入的 Android/Harmony code_map 为依据；不得并行发起多次全模块 CodeGraph 查询。',
      '- 用户要求核验“当前源码”时，只按 code_map 已登记的精确源码路径直接 read，并且一次并行完成：Android 最多 2 次、Harmony 最多 2 次、总计最多 4 次 read 工具调用。',
      '- 每次 read 直接覆盖入口、保存/更新和失败处理所在关键区间（单次最多 240 行）；禁止重读同一文件的重叠区间，完成这一批后必须立即作答，不得追加第二批读取。',
      '- 精确路径可读时禁止 kb_codegraph_*、glob、grep；路径失效时才允许一次带 module_rel 的 kb_codegraph_search，超时或无结果后立即基于文档基线作答并标明版本边界。',
    )
  } else {
    lines.push(
      '- 当前知识源未提供完整双端 code_map；先按文档事实作答。确需源码补证时只允许一次 scoped 检索，禁止并行宽搜。',
    )
  }
  lines.push('- 结论中明确区分“知识库已确认事实”“源码补充证据”和“待确认项”。', '')
  return `${lines.join('\n')}\n`
}

export function buildL2MandatoryDirective(opts: {
  classHints?: string[]
  featureId?: string
  crossPlatform?: boolean
  projectId?: string
  harmonyWorkspaceAlias?: string
  message?: string
  platformPlan?: PlatformSearchPlan
  moduleRel?: string
  sourcePath?: string
}) {
  const hints = (opts.classHints || []).filter(Boolean).slice(0, 3)
  const primary = hints[0] || '目标类名'
  const projectId = opts.projectId || 'demo-project'
  const harmonyAlias = opts.harmonyWorkspaceAlias || 'harmony-src'
  const androidAlias = 'android-src'
  const plan = opts.platformPlan || resolvePlatformSearchPlan(opts.message || '')
  const includeHarmony = opts.crossPlatform ?? plan.includeHarmony
  const moduleRel = String(opts.moduleRel || '').trim()
  const sourcePath = String(opts.sourcePath || '').trim()

  const harmonyModuleRelHint = ''

  const lines = [
    '[工台强制 · L2 代码图谱]',
    `本问属于类/调用链/双端分析（project_id=${projectId}）。**未指定 Android/鸿蒙端时默认 Android 优先**（${androidAlias}）。`,
    `**module_rel 须用仓内模块路径**（如 \`entry\` 或 \`feature/sample\`），**禁止**传 \`${harmonyAlias}/...\` 或 \`.ets\` 文件路径。`,
    `**禁止**在尚未调用 android-harmony-kb-mcp 的情况下 read/glob/grep ${androidAlias}${includeHarmony ? ` 或 ${harmonyAlias}` : ''}。`,
  ]
  if (moduleRel) {
    lines.push(
      `工台已定位 Android 模块：module_rel=${moduleRel}${sourcePath ? `，主文件=${sourcePath}` : ''}。`,
      '**禁止**先调用 status/explore 或不带 module_rel 扫描全部模块；直接定向查询：',
      `1. kb_codegraph_search — project_id=${projectId}，platform=android，module_rel=${moduleRel}，query="${primary}"，limit=5`,
      `2. kb_codegraph_callers / kb_codegraph_callees / kb_codegraph_impact — project_id=${projectId}，platform=android，module_rel=${moduleRel}，基于上一步 symbol`,
      '3. 任一 L2 调用超时或无命中，只尝试一次；立即使用工台预读源码或已知主文件作答，不得改为全模块重试。',
    )
    if (includeHarmony) {
      lines.push(
        `4. 仅题干要求鸿蒙/双端时，再用 L1 code_map 或 platform=harmonyos 定向检索${harmonyModuleRelHint ? `（module_rel=${harmonyModuleRelHint}）` : ''}`,
      )
    }
    lines.push('', describeL2GrepFallback(primary, { ...plan, includeHarmony }, { android: androidAlias, harmony: harmonyAlias }), '')
    return `${lines.join('\n')}\n`
  }

  lines.push(
    '按顺序执行（工具名须通过 MCP 服务器 android-harmony-kb-mcp 调用；**所有 kb_codegraph_* 须传 project_id**）：',
    `1. kb_codegraph_search — project_id=${projectId}，query="${primary}"，platform=android，limit=5；禁止搜包名前缀，禁止先 status/explore 扫全部模块`,
  )
  if (opts.featureId) {
    lines.push(`2. 若上一步命中多个结果，只选精确类/FQN 对应的 module_rel，不得扩大检索`)
    if (includeHarmony) {
      lines.push(
        `3. kb_resolve_counterpart — project_id=${projectId}，feature_id=${opts.featureId} 或 symbol=${primary}（from_platform=android）`,
      )
      lines.push(
        `4. kb_codegraph_search — project_id=${projectId}，platform=harmonyos，query="${primary.includes('.') ? primary.split('.').pop() : primary}"${harmonyModuleRelHint ? `，module_rel=${harmonyModuleRelHint}` : '（用业务关键词；勿用 Android Fragment 类名）'}`,
      )
      lines.push(
        `5. kb_codegraph_callers / kb_codegraph_callees — project_id=${projectId}，基于 Android L2 返回 symbol 串主链`,
      )
    } else {
      lines.push(
        `3. kb_codegraph_callers / kb_codegraph_callees / kb_codegraph_impact — project_id=${projectId}，基于 L2 返回 symbol`,
      )
    }
  } else {
    lines.push(
      `2. 仅无精确类名、只有业务主题时才可 kb_codegraph_explore — project_id=${projectId}，query="${primary}"，platform=android，limit=6`,
    )
    lines.push(`3. kb_codegraph_callers / kb_codegraph_callees — project_id=${projectId}，platform=android`)
    if (includeHarmony) {
      lines.push(
        `4. Android 主链清楚后：platform=harmonyos + kb_codegraph_search（query 业务词或类名${harmonyModuleRelHint ? `，module_rel=${harmonyModuleRelHint}` : ''}）`,
      )
    }
  }
  const readStep = opts.featureId ? (includeHarmony ? '6' : '4') : includeHarmony ? '5' : '4'
  if (includeHarmony) {
    lines.push(`${readStep}. L2 有效命中后，才允许 scoped read（单文件≤200行）；Harmony 读 ${harmonyAlias}/`)
  } else {
    lines.push(`${readStep}. L2 有效命中后，才允许 scoped read ${androidAlias}（单文件≤200行）`)
  }
  lines.push(
    '',
    describeL2GrepFallback(primary, { ...plan, includeHarmony }, { android: androidAlias, harmony: harmonyAlias }),
  )
  lines.push(
    '若 OpenCode 工具列表中看不到 kb_codegraph_*，说明 android-harmony-kb-mcp 未挂载——停止裸扫并提示用户检查 opencode.json / dev:stack。',
  )
  lines.push('')
  return `${lines.join('\n')}\n`
}

function hasClassAnchor(message: string, classRefs: OpencodeClassRef[]) {
  if (classRefs.some((x) => String(x.fqn || '').trim())) return true
  return extractClassHintsFromMessage(message).length > 0
}

function buildIntentDirective(intent: OpencodeIntent, fallbackLevel: OpencodeFallbackLevel) {
  const lines = [`[工台意图：${intent}]`]

  switch (intent) {
    case 'off_topic':
      lines.push('本问与 Android/Harmony 迁移技术无关；简短回应并引导回正题。')
      lines.push('**禁止** glob/grep/read `android-src/`、`harmony-kb/`。')
      break
    case 'concept_only':
      lines.push('本问为概念/语法/通用 API 说明；**无需**检索 `android-src/` 或 `harmony-kb/`。')
      lines.push(`可直接作答；若需企业规范先查 L1 业务知识，历史方案可读共享 ${migrationKnowledgeRoots()}。`)
      lines.push('**禁止** 无范围全库 glob/grep。')
      lines.push('若用户追问具体工程入口/页面类/源码路径，须升级为 scoped 检索（L2→grep→read）并闭环作答。')
      break
    case 'asset_url':
      lines.push('本问为业务接口 URL / ConfigKey 定位 / 接口刷新机制；**必须** follow `[接口 URL …]` 块，以 android-src 源码为最终事实。')
      lines.push('**禁止** 仅凭迁移案例或行业经验断言 ConfigKey/URL/刷新方式；案例仅可对照，不一致以源码为准。')
      lines.push('须 grep 题干 URL path 段并 read 命中类；证据路径至少含 `android-src/…` 或 `live-src/…`。')
      break
    case 'asset_drawable':
      lines.push('本问为 drawable/mipmap 原图；**必须** follow `[图标原图展示]` / `[drawable 预检索 …]` 块。')
      lines.push('**作答形式只能是 opencode-asset Markdown 图片**（`![名](opencode-asset:<workspace-alias>/.../xxx.webp)`）；**禁止**口头说「已返回/已给出」而无图片链接。')
      lines.push('**禁止** kb_codegraph_* / codegraph query 搜 webp/png 位图（L2 不索引 res/drawable* 与二进制图片）；须用工台预检索 + scope glob/read 密度目录。')
      lines.push('fallback：scope 内按密度目录 glob/read，并使用当前应用配置注入的 workspace alias。')
      break
    case 'harmony_generate':
      lines.push('本问需要鸿蒙代码生成；**必须先** L2 MCP 理解 Android/Harmony 符号与调用链，L2 不满意再 scope 内 grep，最后 scoped read 并输出 ArkTS。')
      lines.push('若已有 `[工台知识库上下文]`，以其主链为准；L1 **不能**替代 L2。')
      break
    case 'android_analyze':
      lines.push(
        '本问为 Android 业务/调用链/双端对齐/鸿蒙入口探索。若有 `[工台预读源码]` 且足以回答当前类职责，直接作答；若有 `[工台 · L1 已登记类]`，先按 L1 作答；只有后续另附独立的 L2 强制块时才必须先调 L2。',
      )
      lines.push('**平台默认**：题干未指定 Android/鸿蒙端时，L2/grep/read **默认 Android 优先**（live-src/android-src）；仅题干明确要求鸿蒙/双端/对应/ArkTS 时再查 harmony 仓。')
      lines.push('**必须闭环**：L1/L2 均无命中时不得停止；须 grep/read 直至列出入口类与路径，或明确已搜过的 scope 与关键词。')
      lines.push(buildCodeFactsDirective())
      break
    default:
      break
  }

  if (fallbackLevel !== 'none') {
    lines.push('')
    lines.push(buildFallbackPriorityDirective(fallbackLevel))
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

export function buildFallbackPriorityDirective(level: OpencodeFallbackLevel) {
  switch (level) {
    case 'none':
      return '[检索 fallback：none — 禁止代码检索]'
    case 'docs_only':
      return `[检索 fallback 优先级]
1. 查询 L1 业务知识；需要历史方案时 read 共享 ${migrationKnowledgeRoots()}
2. 若题干含 URL / 接口 / Android 实现 / 刷新机制 → **必须升级** scope 内 grep/read 源码，禁止 android-src 禁搜
3. 仍不足 → 说明已搜 docs + 源码关键词；**禁止**空泛经验作答`
    case 'kb_first':
      return `[检索 fallback 优先级]
0. ${buildCodeFactsDirective()}
1. 若含 \`[工台预读源码]\` 且足以回答类职责 → 直接作答，禁止重复 L1/L2/read
2. 若含 \`[工台 · L1 已登记类 · 作答顺序]\` → 先基于 L1 主链作答，L2/read 仅补全
3. 仅当后续另附独立的 L2 强制块时先调 L2；已知 module 必须定向查询，禁止先 status/explore 全模块探测
4. L2 不满意或仍不足 → grep 当前 Android scope；题干含鸿蒙/双端时再查 Harmony
5. **禁止** Harmony 无同名类时判定「L2 不可用」；仍无结论时说明已搜范围与关键词`
    case 'index_scoped':
      return `[检索 fallback 优先级]
0. ${buildCodeFactsDirective()}
1. follow \`[接口 URL …]\` / \`[类检索 …]\` / \`[图标原图展示 …]\` / \`[drawable 预检索 …]\` 与 SQLite 索引给出的 read 路径
2. **drawable/webp/png 原图**：禁止 kb_codegraph_*；须 scope glob \`{alias}/<前缀>/**/res/drawable-<density>/xxx.*\` 或 read 密度目录
3. scope 内 glob \`{alias}/**/{ClassName}.{java,kt}\` → grep ConfigKey/getKtvConfigUrl → read（URL 类须先 read Protocol + ConfigKeys）
4. **禁止** 以迁移案例单独作为 ConfigKey/URL 证据；案例仅作对照
5. **禁止** 全库 \`android-src/**/*.java\`；glob 命中 >20 须收窄
6. 仍无结论 → 请用户补充类名或切换应用范围`
    case 'full_scoped':
      return `[检索 fallback 优先级]
1. 同 index_scoped
2. 可追加 read \`harmony-kb/\` 索引（若 env 已配置）
3. 轮次上限：glob+grep+read 合计 ≤8（建议 2 glob + 2 grep + 4 read）`
    default:
      return ''
  }
}

function finalizeIntentPlan(
  plan: Omit<OpencodeIntentPlan, 'requireL2BeforeRead'>,
  message: string,
  classAnchor: boolean,
): OpencodeIntentPlan {
  return {
    ...plan,
    requireL2BeforeRead: shouldRequireL2BeforeRead(plan.intent, message, classAnchor),
  }
}

/**
 * 对用户消息做意图分类，并返回 BFF 应注入哪些块。
 * 规则优先于模型自主；后续可替换为轻量模型分类，接口保持不变。
 */
export function classifyOpencodeIntent(
  message: string,
  classRefs: OpencodeClassRef[] = [],
): OpencodeIntentPlan {
  const text = String(message || '').trim()
  const classAnchor = hasClassAnchor(text, classRefs)
  const urlIntent = shouldUseKtvUrlLookup(text)
  const engineeringFact = isEngineeringFactQuestion(text)
  const workbenchCode = isWorkbenchCodeQuestion(text)
  const imageIntent = isOpencodeImageIntent(text)
  const harmonyGenerate = HARMONY_GENERATE_RE.test(text)
  const androidAnalyze =
    ANDROID_ANALYZE_RE.test(text) || classAnchor || engineeringFact || workbenchCode

  if (OFF_TOPIC_RE.test(text) && !classAnchor && !urlIntent && !imageIntent) {
    return finalizeIntentPlan(
      {
        intent: 'off_topic',
        fallbackLevel: 'none',
        injectScope: false,
        injectClassHint: false,
        injectKnowledge: false,
        injectUrlDirective: false,
        injectImageDirective: false,
        intentDirective: buildIntentDirective('off_topic', 'none'),
      },
      text,
      classAnchor,
    )
  }

  if (urlIntent && !harmonyGenerate) {
    return finalizeIntentPlan(
      {
        intent: 'asset_url',
        fallbackLevel: 'index_scoped',
        injectScope: true,
        injectClassHint: Boolean(classAnchor),
        injectKnowledge: false,
        injectUrlDirective: true,
        injectImageDirective: false,
        intentDirective: buildIntentDirective('asset_url', 'index_scoped'),
      },
      text,
      classAnchor,
    )
  }

  if (imageIntent && !harmonyGenerate && !androidAnalyze) {
    return finalizeIntentPlan(
      {
        intent: 'asset_drawable',
        fallbackLevel: 'index_scoped',
        injectScope: true,
        injectClassHint: false,
        injectKnowledge: false,
        injectUrlDirective: false,
        injectImageDirective: true,
        intentDirective: buildIntentDirective('asset_drawable', 'index_scoped'),
      },
      text,
      classAnchor,
    )
  }

  if (
    CONCEPT_ONLY_RE.test(text) &&
    !classAnchor &&
    !urlIntent &&
    !engineeringFact &&
    !workbenchCode &&
    !imageIntent &&
    !harmonyGenerate &&
    !ANDROID_CONTEXT_RE.test(text)
  ) {
    return finalizeIntentPlan(
      {
        intent: 'concept_only',
        fallbackLevel: 'docs_only',
        injectScope: false,
        injectClassHint: false,
        injectKnowledge: false,
        injectUrlDirective: false,
        injectImageDirective: false,
        intentDirective: buildIntentDirective('concept_only', 'docs_only'),
      },
      text,
      classAnchor,
    )
  }

  if (harmonyGenerate) {
    return finalizeIntentPlan(
      {
        intent: 'harmony_generate',
        fallbackLevel: 'kb_first',
        injectScope: true,
        injectClassHint: true,
        injectKnowledge: true,
        injectUrlDirective: urlIntent,
        injectImageDirective: imageIntent,
        intentDirective: buildIntentDirective('harmony_generate', 'kb_first'),
      },
      text,
      classAnchor,
    )
  }

  if (androidAnalyze || classAnchor) {
    return finalizeIntentPlan(
      {
        intent: 'android_analyze',
        fallbackLevel: 'kb_first',
        injectScope: true,
        injectClassHint: true,
        injectKnowledge: true,
        injectUrlDirective: urlIntent,
        injectImageDirective: imageIntent,
        intentDirective: buildIntentDirective('android_analyze', 'kb_first'),
      },
      text,
      classAnchor,
    )
  }

  if (KTV_BUSINESS_RE.test(text)) {
    return finalizeIntentPlan(
      {
        intent: 'android_analyze',
        fallbackLevel: 'kb_first',
        injectScope: true,
        injectClassHint: Boolean(classAnchor),
        injectKnowledge: true,
        injectUrlDirective: urlIntent,
        injectImageDirective: imageIntent,
        intentDirective: buildIntentDirective('android_analyze', 'kb_first').replace(
          '本问为 Android 业务/调用链/双端对齐/鸿蒙入口探索',
          KTV_COMPARE_RE.test(text)
            ? '本问为唱/KTV 业务对比或说明（无 @类名，工台将注入 harmony-kb feature + doc-summary）'
            : '本问为唱/KTV 业务说明（无 @类名，工台将注入 harmony-kb）',
        ),
      },
      text,
      classAnchor,
    )
  }

  if (isHarmonyScopedQuestion(text)) {
    return finalizeIntentPlan(
      {
        intent: 'android_analyze',
        fallbackLevel: 'kb_first',
        injectScope: true,
        injectClassHint: Boolean(classAnchor),
        injectKnowledge: true,
        injectUrlDirective: urlIntent,
        injectImageDirective: imageIntent,
        intentDirective: buildIntentDirective('android_analyze', 'kb_first'),
      },
      text,
      classAnchor,
    )
  }

  if (engineeringFact || workbenchCode || ANDROID_CONTEXT_RE.test(text)) {
    return finalizeIntentPlan(
      {
        intent: urlIntent ? 'asset_url' : 'android_analyze',
        fallbackLevel: urlIntent ? 'index_scoped' : 'kb_first',
        injectScope: true,
        injectClassHint: Boolean(classAnchor),
        injectKnowledge: !urlIntent,
        injectUrlDirective: urlIntent,
        injectImageDirective: false,
        intentDirective: buildIntentDirective(
          urlIntent ? 'asset_url' : 'android_analyze',
          urlIntent ? 'index_scoped' : 'kb_first',
        ),
      },
      text,
      classAnchor,
    )
  }

  return finalizeIntentPlan(
    {
      intent: 'android_analyze',
      fallbackLevel: 'kb_first',
      injectScope: true,
      injectClassHint: Boolean(classAnchor),
      injectKnowledge: true,
      injectUrlDirective: urlIntent,
      injectImageDirective: imageIntent,
      intentDirective: buildIntentDirective('android_analyze', 'kb_first').replace(
        '本问为 Android 业务/调用链/双端对齐/鸿蒙入口探索',
        '本问未命中专类规则；工台默认按 Android 业务题处理，须 scope 内检索源码后再答',
      ),
    },
    text,
    classAnchor,
  )
}
