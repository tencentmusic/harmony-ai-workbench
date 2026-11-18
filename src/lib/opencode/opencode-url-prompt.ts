import { findAndroidClassesByExactName, listAndroidAppScopes } from '@/lib/android-class-index'
import { toAndroidWorkspacePath } from '@/lib/android-workspace-path'
import {
  buildKtvUrlLookupRulesText,
  extractUrlBusinessClassHints,
  extractUrlPathGrepHints,
  KTV_URL_CONTEXT_CLASS_NAMES,
  shouldUseKtvUrlLookup,
} from '@/lib/ktv-url-lookup'
import {
  getAppScopeSearchPrefixes,
  resolveRequestedAppScopeId,
} from '@/lib/opencode/opencode-app-scope'

export function isOpencodeUrlIntent(message: string) {
  return shouldUseKtvUrlLookup(message)
}

function resolveScopeLabel(appScopeId: string, allowedScopeIds: string[]) {
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  if (sid === 'all') return '全部应用'
  return listAndroidAppScopes().find((s) => s.id === sid)?.label || sid
}

function toWorkspacePath(relativePath: string) {
  return toAndroidWorkspacePath(relativePath)
}

function pickBestIndexRow<T extends { module: string }>(rows: T[]) {
  return (
    rows.find((x) => x.module.startsWith('feature/inline/')) ||
    rows.find((x) => x.module.startsWith('feature/api/')) ||
    rows.find((x) => x.module.startsWith('library/')) ||
    rows[0]
  )
}

async function lookupClassInScope(className: string, scopePrefixes: string[]) {
  const scopedRows = scopePrefixes.length
    ? await findAndroidClassesByExactName(className, 6, scopePrefixes).catch(() => [])
    : []
  const fallbackRows =
    scopedRows.length === 0
      ? await findAndroidClassesByExactName(className, 6).catch(() => [])
      : []
  const rows = scopedRows.length ? scopedRows : fallbackRows
  return pickBestIndexRow(rows)
}

async function buildKtvUrlClassPresearch(scopePrefixes: string[]) {
  const lines: string[] = ['[接口 URL 预检索 — URL 基础设施类（须 read）]']
  let hit = 0

  for (const className of KTV_URL_CONTEXT_CLASS_NAMES) {
    const picked = await lookupClassInScope(className, scopePrefixes)
    if (!picked) {
      lines.push(`- \`${className}\`：索引未命中 → glob \`android-src/**/${className}.{java,kt}\`（限 [应用范围]）`)
      continue
    }
    hit += 1
    lines.push(`- \`${className}\` FQN=${picked.fqn} module=${picked.module}`)
    lines.push(`  read：\`${toWorkspacePath(picked.relativePath)}\``)
  }

  if (!hit) {
    lines.push('- 索引均未命中：glob `android-src/**/KtvModuleConfigKeys.{java,kt}` 或 `KtvConfigKeys.{java,kt}`')
  }

  lines.push('')
  return { directive: `${lines.join('\n')}\n`, hit }
}

async function buildProtocolPresearch(userMessage: string, scopePrefixes: string[]) {
  const hints = extractUrlBusinessClassHints(userMessage)
  if (!hints.length) return ''

  const lines: string[] = ['[接口 URL 预检索 — 业务 Protocol/Delegate（须先 grep/read）]']
  for (const className of hints) {
    const picked = await lookupClassInScope(className, scopePrefixes)
    if (!picked) {
      lines.push(
        `- \`${className}\`：索引未命中 → grep \`android-src/**/${className}.{java,kt}\` 查 ConfigKey / getKtvConfigUrl`,
      )
      continue
    }
    lines.push(`- \`${className}\` FQN=${picked.fqn} module=${picked.module}`)
    lines.push(`  grep/read：\`${toWorkspacePath(picked.relativePath)}\`（查 ConfigKey 分支与 URL 生成）`)
  }
  lines.push('- **禁止** 未 read 上述 Protocol 就以迁移案例单独下结论')
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function augmentOpencodeMessageWithUrlDirective(
  userMessage: string,
  appScopeId: string,
  allowedScopeIds: string[],
) {
  if (!shouldUseKtvUrlLookup(userMessage)) {
    return { directive: '' }
  }

  const scopePrefixes = getAppScopeSearchPrefixes(appScopeId, allowedScopeIds)
  const scopeLabel = resolveScopeLabel(appScopeId, allowedScopeIds)
  const presearch = await buildKtvUrlClassPresearch(scopePrefixes)
  const protocolPresearch = await buildProtocolPresearch(userMessage, scopePrefixes)
  const urlGrepHints = extractUrlPathGrepHints(userMessage)
  const urlGrepBlock =
    urlGrepHints.length > 0
      ? `[接口 URL 预检索 — 题干 URL path（须先 grep）]\n${urlGrepHints.map((h) => `- grep \`{alias}/**/*\` 关键词 \`${h}\`（ConfigKey / path / 接口常量）`).join('\n')}\n**禁止** 未 grep 命中就凭 docs/经验描述刷新机制。\n\n`
      : ''
  const base = buildKtvUrlLookupRulesText().replace(
    '[接口 URL 定位 — 强制流程]',
    `[接口 URL 定位 — 强制流程 · 当前应用范围：${scopeLabel}]`,
  )

  return {
    directive: `${base}${urlGrepBlock}${protocolPresearch}${presearch.directive}`,
  }
}
