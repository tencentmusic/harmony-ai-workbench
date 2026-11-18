import {
  findWorkspaceApp,
  listPortalKnowledgeWorkspaceRoots,
  loadWorkspaceAppsConfig,
  resolveAppHarmonyRepoPath,
} from '@/lib/workspace-apps-config'
import {
  getAndroidAppScopeById,
  getAndroidAppScopePrefixes,
  getAndroidScopePrefixesByIds,
  getHarmonyAppScopePrefixes,
  listAndroidAppScopes,
  scopeHasHarmonySource,
} from '@/lib/android-app-scopes'
import {
  formatKbProjectScopeMapping,
  labelKbProject,
  listKbProjectIdsFromScopeIds,
  resolveHarmonyWorkspaceAliasForKbProject,
  resolveKbProjectIdForChat,
} from '@/lib/kb-project-labels'
import {
  formatAllModeAndroidSearchRoots,
  formatAllModeHarmonySearchRoots,
  formatHarmonyScopeSearchRoot,
  formatScopeSearchRoot,
  getWorkspaceAliasForScope,
} from '@/lib/android-workspace-path'

import type { OpencodeImageRef } from '@/lib/opencode/opencode-image'
import type { ChatMessage } from '@/lib/chat-store'
import {
  buildContinuedOpencodePrompt,
  type OpencodeChatContinuity,
} from '@/lib/opencode/opencode-session-continuity'

import { augmentOpencodeMessageWithImageDirective } from '@/lib/opencode/opencode-image-prompt'
import { augmentOpencodeMessageWithUrlDirective } from '@/lib/opencode/opencode-url-prompt'
import type { OpencodeKnowledgeMeta } from '@/lib/opencode/opencode-knowledge-context'
import type { KnowledgeLocator } from '@/contracts/knowledge'
import {
  buildL1RegisteredClassDirective,
  buildL2MandatoryDirective,
  buildSelectedKnowledgeDocumentDirective,
  classifyOpencodeIntent,
  extractClassHintsFromMessage,
  isL1RegisteredClassMatch,
  resolvePlatformSearchPlan,
} from '@/lib/opencode/opencode-intent'



export function resolveRequestedAppScopeId(requestedScopeId: string, allowedScopeIds: string[]) {

  const requested = String(requestedScopeId || '').trim()

  const allowed = [...new Set(allowedScopeIds.map((x) => String(x || '').trim()).filter(Boolean))]

  if (!allowed.length) return requested || 'all'

  if (requested && requested !== 'all' && allowed.includes(requested)) return requested

  if (requested && requested !== 'all') return allowed[0]

  return 'all'

}



export function getAppScopeSearchPrefixes(appScopeId: string, allowedScopeIds: string[]) {

  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)

  if (sid === 'all') {

    return allowedScopeIds.length ? getAndroidScopePrefixesByIds(allowedScopeIds) : []

  }

  return getAndroidAppScopePrefixes(sid)

}



export function buildOpencodeAppScopeDirective(
  appScopeId: string,
  allowedScopeIds: string[],
  opts?: { kbProjectId?: string; classRefs?: Array<{ fqn?: string }>; message?: string },
) {

  const scopes = listAndroidAppScopes()

  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  const kbProjectId =
    opts?.kbProjectId ||
    resolveKbProjectIdForChat({
      appScopeId: sid,
      allowedScopeIds,
      classRefs: opts?.classRefs,
      message: opts?.message,
    })
  const kbProjectLabel = labelKbProject(kbProjectId)
  const harmonyWorkspaceAlias = resolveHarmonyWorkspaceAliasForKbProject(kbProjectId)

  const prefixes = getAppScopeSearchPrefixes(appScopeId, allowedScopeIds)
  const scope = getAndroidAppScopeById(sid === 'all' ? undefined : sid)



  let label = '全部应用'

  if (sid === 'all') {

    if (allowedScopeIds.length) {

      label = allowedScopeIds

        .map((id) => scopes.find((s) => s.id === id)?.label || id)

        .join('、')

    }

  } else {

    label = scopes.find((s) => s.id === sid)?.label || sid

  }



  const searchRoots =
    sid === 'all' && allowedScopeIds.length
      ? formatAllModeAndroidSearchRoots(allowedScopeIds)
      : !prefixes.length
        ? `${getWorkspaceAliasForScope(scope)}/（未限定前缀时全仓库检索）`
        : prefixes.length <= 15
          ? prefixes.map((p) => formatScopeSearchRoot(p, scope)).join('、')
          : `共 ${prefixes.length} 个模块前缀（完整列表见 workspace/app-scopes.json）；glob 时 module 必须匹配其中之一。示例：${prefixes
              .slice(0, 6)
              .map((p) => formatScopeSearchRoot(p, scope))
              .join('、')}…`

  const harmonyRoots =
    sid === 'all' && allowedScopeIds.length
      ? formatAllModeHarmonySearchRoots(allowedScopeIds)
      : (() => {
          const harmonyPrefixes = getHarmonyAppScopePrefixes(sid)
          if (!harmonyPrefixes.length || !scopeHasHarmonySource(scope)) return ''
          return harmonyPrefixes.length <= 12
            ? harmonyPrefixes.map((p) => formatHarmonyScopeSearchRoot(p, scope)).join('、')
            : `共 ${harmonyPrefixes.length} 个鸿蒙模块前缀（见 app-scopes.json）。示例：${harmonyPrefixes
                .slice(0, 4)
                .map((p) => formatHarmonyScopeSearchRoot(p, scope))
                .join('、')}…`
        })()



  const lines = [
    `[应用范围：${label}]`,
    `KB project_id: ${kbProjectId}（${kbProjectLabel}）— MCP kb_knowledge_* / get_feature_context / kb_codegraph_* / kb_resolve_counterpart 须带此 project_id`,
  ]
  if (sid === 'all' && listKbProjectIdsFromScopeIds(allowedScopeIds).length > 1) {
    lines.push(
      `多 App 范围 project_id 对照：${formatKbProjectScopeMapping(allowedScopeIds).join('；')}。讨论某 App / @harmony.{ScopeId}.* 时须切换为对应 project_id。`,
    )
  }
  lines.push(
    `Android glob/grep/read 仅限定在：${searchRoots}`,
    `**平台默认**：题干未指定 Android/鸿蒙端时，L2/grep/read **默认 Android 优先**；仅题干明确要求鸿蒙/双端/对应/ArkTS 时再查 Harmony 仓。`,
  )
  const migrationRoots = listPortalKnowledgeWorkspaceRoots('migration')
  if (migrationRoots.length) {
    lines.push(
      `共享迁移案例可从 ${migrationRoots.map((root) => `\`${root}/\``).join('、')} 读取；案例是历史证据，不受 App 范围裁剪，也不得覆盖业务知识或当前源码结论。`,
    )
  }
  if (harmonyRoots) {
    lines.push(`Harmony glob/grep/read 仅限定在：${harmonyRoots}`)
    if (sid !== 'all') {
      const appEntry = findWorkspaceApp(sid)
      const harmonyAbsPath = appEntry ? resolveAppHarmonyRepoPath(appEntry) : ''
      if (harmonyAbsPath) {
        lines.push(
          `Harmony 工程根（workspace \`${harmonyWorkspaceAlias}/\`）→ ${harmonyAbsPath.replace(/\\/g, '/')}`,
        )
      }
    } else {
      lines.push(
        'Harmony 多仓按上文各 App 的 workspace alias 区分，禁止跨项目读取。',
      )
    }
    lines.push(
      `双端/鸿蒙题：优先项目绑定的 L1 业务知识/双端 code_map；细节不足时再 kb_codegraph_* / kb_resolve_counterpart（project_id=${kbProjectId}）；仍不足再 grep/read 对应 Harmony 仓。`,
    )
    lines.push(
      `**必须闭环**：L1/L2 无命中时不得停止；须在对应 Harmony 仓内 grep module.json5、EntryAbility、pages/ 等直至列出入口或说明已搜路径。`,
    )
  }
  lines.push('禁止到其他应用目录搜索或引用结论。')
  lines.push('**禁止**根据 Java 包名推断类属于哪个 App；必须在上述 scope 内 glob/grep 后再下结论。')
  lines.push('')

  return `${lines.join('\n')}\n`

}



export type AugmentedOpencodeMessage = {

  text: string

  presearchImages: OpencodeImageRef[]

}

export type AugmentOpencodeMessageOptions = {
  /** 复用 OpenCode session 续聊时传入；BFF 不再注入意图/检索块，交由 session 历史 + AGENTS 约束 */
  opencodeSessionId?: string | null
  continuity?: OpencodeChatContinuity
  priorMessages?: ChatMessage[]
  knowledgeLocator?: KnowledgeLocator | null
}

function buildKnowledgeLocatorDirective(locator?: KnowledgeLocator | null, l1Hit = false) {
  if (!locator) return ''
  if (l1Hit) {
    return `[工台 · 已定位知识文档]\n知识源：${locator.sourceId}\n文档：${locator.workspaceAlias}/${locator.docPath}\n该文档及关联代码地图已注入下方 L1，无需再次 read 或搜索知识库。\n\n`
  }
  return `[工台 · 已定位知识文档]\n知识源：${locator.sourceId}\n文档：${locator.workspaceAlias}/${locator.docPath}\n先直接 read 上述精确文档；无需再次搜索或扫描知识库来定位该文档。\n\n`
}

export async function augmentOpencodeMessage(

  userMessage: string,

  appScopeId: string,

  allowedScopeIds: string[],

  classRefs: Array<{ fqn: string; module?: string }> = [],

  telemetry?: { chatSessionId?: string; apiTokenId?: string },

  options: AugmentOpencodeMessageOptions = {},

): Promise<AugmentedOpencodeMessage> {
  const trimmedMessage = String(userMessage || '').trim()
  const continuity = options.continuity || 'fresh'
  const explicitClassTarget =
    classRefs.some((item) => String(item.fqn || '').trim()) || extractClassHintsFromMessage(trimmedMessage).length > 0
  if (continuity !== 'fresh' && !explicitClassTarget && !options.knowledgeLocator) {
    return {
      text: buildContinuedOpencodePrompt({
        continuity,
        userMessage: trimmedMessage,
        priorMessages: options.priorMessages,
      }),
      presearchImages: [],
    }
  }
  const continuityReset =
    continuity !== 'fresh'
      ? options.knowledgeLocator
        ? `[工台 · 续聊中新知识文档]\n当前问题来自新选中的知识文档；以本轮文档、关联代码地图和应用范围为准，不得沿用上文其他功能的结论。\n\n`
        : `[工台 · 续聊中新类目标]\n当前问题明确指定了类名/FQN；以本轮 [类检索]、[应用范围] 和预读源码为准，不得沿用上文其他同名类或旧 module。\n\n`
      : ''

  const plan = classifyOpencodeIntent(userMessage, classRefs)
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  const kbProjectId = resolveKbProjectIdForChat({
    appScopeId: sid,
    allowedScopeIds,
    classRefs,
    message: userMessage,
  })
  const harmonyWorkspaceAlias = resolveHarmonyWorkspaceAliasForKbProject(kbProjectId)

  let scope = ''
  let classHint = ''
  let classModuleRel = ''
  let classSourcePath = ''
  let knowledgeHint = ''
  let knowledgeMeta: OpencodeKnowledgeMeta | undefined
  let urlDirective = ''
  let imageDirective = ''
  let presearchImages: OpencodeImageRef[] = []

  if (plan.injectScope) {
    scope = buildOpencodeAppScopeDirective(appScopeId, allowedScopeIds, {
      kbProjectId,
      classRefs,
      message: userMessage,
    })
  }

  if (plan.injectClassHint) {
    const { buildOpencodeClassIndexBundle } = await import('@/lib/opencode/opencode-class-hint')
    const classBundle = await buildOpencodeClassIndexBundle(userMessage, appScopeId, allowedScopeIds, classRefs)
    classHint = classBundle.directive
    const primaryFqn = classRefs[0]?.fqn || extractClassHintsFromMessage(userMessage)[0]
    const exactMatch = classBundle.matches.find((item) => item.fqn === primaryFqn) || classBundle.matches[0]
    classModuleRel = classRefs.find((item) => item.fqn === primaryFqn)?.module || exactMatch?.module || ''
    classSourcePath = exactMatch?.workspacePath || ''
  }

  if (plan.injectKnowledge) {
    const { buildOpencodeKnowledgeBundle } = await import('@/lib/opencode/opencode-knowledge-context')
    const bundle = await buildOpencodeKnowledgeBundle(userMessage, classRefs, telemetry, {
      appScopeId: sid,
      projectId: kbProjectId,
      harmonyWorkspaceAlias,
    })
    knowledgeHint = bundle.directive
    knowledgeMeta = bundle.meta
  }

  let l2Mandatory = ''
  if (options.knowledgeLocator && knowledgeMeta?.hit) {
    l2Mandatory = buildSelectedKnowledgeDocumentDirective({
      docPath: `${options.knowledgeLocator.workspaceAlias}/${options.knowledgeLocator.docPath}`,
      codeMapRefs: knowledgeMeta.code_map_refs,
      crossPlatformReady: knowledgeMeta.cross_platform_ready,
    })
  } else if (plan.requireL2BeforeRead) {
    const classHints = [
      ...classRefs.map((x) => String(x.fqn || '').trim()).filter(Boolean),
      ...extractClassHintsFromMessage(userMessage),
    ]
    const featureId = knowledgeMeta?.feature_id || knowledgeHint.match(/feature_id:\s*([^\s\n]+)/)?.[1]
    const platformPlan = resolvePlatformSearchPlan(userMessage)
    const directiveOpts = {
      classHints: [...new Set(classHints)],
      featureId,
      crossPlatform: platformPlan.includeHarmony,
      platformPlan,
      message: userMessage,
      projectId: kbProjectId,
      harmonyWorkspaceAlias,
      moduleRel: classModuleRel,
      sourcePath: classSourcePath,
    }
    if (isL1RegisteredClassMatch(knowledgeMeta, plan.intent)) {
      l2Mandatory = buildL1RegisteredClassDirective({
        ...directiveOpts,
        matchBy: knowledgeMeta?.match_by,
      })
    } else {
      l2Mandatory = buildL2MandatoryDirective(directiveOpts)
    }
  }

  if (plan.injectUrlDirective) {
    const url = await augmentOpencodeMessageWithUrlDirective(userMessage, appScopeId, allowedScopeIds)
    urlDirective = url.directive
  }

  if (plan.injectImageDirective) {
    const image = await augmentOpencodeMessageWithImageDirective(userMessage, appScopeId, allowedScopeIds)
    imageDirective = image.directive
    presearchImages = image.presearchImages
  }

  return {

    text: `${continuityReset}${buildKnowledgeLocatorDirective(options.knowledgeLocator, Boolean(knowledgeMeta?.hit))}${plan.intentDirective}${scope}${classHint}${knowledgeHint}${l2Mandatory}${urlDirective}${imageDirective}用户问题：${userMessage}`,

    presearchImages,

  }

}
