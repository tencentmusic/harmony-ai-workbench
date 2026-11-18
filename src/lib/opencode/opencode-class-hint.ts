import {
  findAndroidClassesByExactName,
  findAndroidClassesByFqn,
  listAndroidAppScopes,
  type AndroidClassIndexItem,
} from '@/lib/android-class-index'
import { getAndroidAppScopeById } from '@/lib/android-app-scopes'
import { formatScopeSearchRoot, toAndroidWorkspacePath } from '@/lib/android-workspace-path'
import {
  getAppScopeSearchPrefixes,
  resolveRequestedAppScopeId,
} from '@/lib/opencode/opencode-app-scope'
import { buildClassSourcePrereadDirective } from '@/lib/opencode/opencode-class-preread'

const FQN_RE = /(?:^|[\s(@])((?:[A-Za-z_][\w$]*\.){2,}[A-Za-z_][\w$]*)(?=[\s,.，。;；:：!?？)]|$)/g
const SIMPLE_CLASS_RE = /(?:^|[\s(@])([A-Z][A-Za-z0-9_]{2,})(?=[\s,.，。;；:：!?？)]|$)/g

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((x) => x.trim()).filter(Boolean))]
}

export function extractClassHintsFromMessage(message: string) {
  const text = String(message || '')
  const fqns: string[] = []
  for (const m of text.matchAll(FQN_RE)) {
    const fqn = String(m[1] || '').trim()
    if (fqn) fqns.push(fqn)
  }
  if (fqns.length) return uniqueStrings(fqns)

  const simple: string[] = []
  for (const m of text.matchAll(SIMPLE_CLASS_RE)) {
    const name = String(m[1] || '').trim()
    if (!name || ['OpenCode', 'Android', 'Harmony'].includes(name)) continue
    simple.push(name)
  }
  return uniqueStrings(simple)
}

function simpleNameFromHint(hint: string) {
  return hint.includes('.') ? hint.split('.').pop() || hint : hint
}

function resolveScopeLabel(appScopeId: string, allowedScopeIds: string[]) {
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  if (sid === 'all') return '全部应用'
  return listAndroidAppScopes().find((s) => s.id === sid)?.label || sid
}

function buildMandatoryScopeSearchLines(hint: string, scopePrefixes: string[], appScopeId: string, allowedScopeIds: string[]) {
  const simpleName = simpleNameFromHint(hint)
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  const scope = getAndroidAppScopeById(sid === 'all' ? undefined : sid)
  const alias = scope?.workspaceAlias || 'android-src'
  const lines = [
    `- 目标 \`${hint}\`（简单类名 \`${simpleName}\`）`,
    '- **SQLite 索引未命中不代表类不存在**；必须在当前 [应用范围] 内继续 glob/grep/read',
    '- **禁止**根据 Java 包名（如 `com.kugou.ktv`、`com.kugou.android`）推断「属于其他 App」并拒绝搜索或让用户切换应用',
    '- 同一 FQN 可能在当前 App 的 `feature/inline/impl_*` 等模块各有一份，包名与 App 名不一一对应',
    '- 必须按顺序执行（均在当前应用范围前缀内）：',
    `  1. glob \`${alias}/**/${simpleName}.{java,kt}\`，再核对命中文件的 module 是否属于当前 scope`,
  ]

  if (scopePrefixes.length) {
    const samples = scopePrefixes
      .slice(0, 4)
      .map((p) => `${formatScopeSearchRoot(p, scope)}**/${simpleName}.{java,kt}`)
    lines.push(`  2. 或按 scope 前缀 glob：${samples.join('、')}${scopePrefixes.length > 4 ? '…' : ''}`)
    lines.push(`  3. grep 在当前 scope 模块下搜索 \`${simpleName}\` 或 FQN 片段`)
  } else {
    lines.push(`  2. grep 在 ${alias} 搜索 \`${simpleName}\` 或完整 FQN`)
  }

  lines.push('  4. read 命中源文件后再作答')
  lines.push(
    '  5. **仅当**上述 scope 内 glob+grep 均无命中，才可回复「当前应用范围内未找到」；可建议用户核对类名或切换应用范围，**不得**在未检索前下结论',
  )
  return lines
}

export type OpencodeClassRef = {
  fqn: string
  module?: string
}

export type OpencodeClassIndexMatch = {
  fqn: string
  module: string
  workspacePath: string
}

export type OpencodeClassIndexBundle = {
  directive: string
  matches: OpencodeClassIndexMatch[]
}

async function resolveClassHintRows(
  hint: string,
  scopePrefixes: string[],
  sid: string,
  allowedScopeIds: string[],
  classRefs: OpencodeClassRef[] = [],
) {
  const scopeId = sid === 'all' ? undefined : sid
  const classRef = classRefs.find((x) => x.fqn === hint)

  if (hint.includes('.')) {
    const fqnRows = await findAndroidClassesByFqn(hint, 6, {
      scopeId,
      allowedScopeIds,
      module: classRef?.module,
    }).catch(() => [])
    if (fqnRows.length) return fqnRows.slice(0, 3)
  }

  const query = simpleNameFromHint(hint)
  const rows = await findAndroidClassesByExactName(query, 6, scopePrefixes, {
    scopeId,
    allowedScopeIds,
  }).catch(() => [])

  if (hint.includes('.')) return []

  const matched = rows.filter((row) => row.className === hint)
  return matched.length ? matched.slice(0, 3) : rows.filter((row) => row.className === query).slice(0, 3)
}

export async function buildOpencodeClassIndexBundle(
  message: string,
  appScopeId: string,
  allowedScopeIds: string[],
  classRefs: OpencodeClassRef[] = [],
): Promise<OpencodeClassIndexBundle> {
  const hints = extractClassHintsFromMessage(message)
  if (!hints.length) return { directive: '', matches: [] }

  const scopePrefixes = getAppScopeSearchPrefixes(appScopeId, allowedScopeIds)
  const scopeLabel = resolveScopeLabel(appScopeId, allowedScopeIds)
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  const lines: string[] = [
    `[类检索 — 当前应用范围：${scopeLabel}]`,
    'SQLite 精确命中且附带 `[工台预读源码]` 时直接分析；只有未命中或预读不足时才在当前 [应用范围] 内 glob/grep/read。',
    '**禁止**据包名推断 App 归属并跳过 scope 内搜索。',
    '',
  ]
  const prereadRows: AndroidClassIndexItem[] = []
  const matches: OpencodeClassIndexMatch[] = []

  for (const hint of hints.slice(0, 3)) {
    const picked = await resolveClassHintRows(hint, scopePrefixes, sid, allowedScopeIds, classRefs)

    if (picked.length) {
      lines.push(`### ${hint} — 索引命中（工台已预读主文件时可跳过 glob/read）`)
      for (const row of picked.slice(0, 3)) {
        const workspacePath = toAndroidWorkspacePath(row.relativePath, sid === 'all' ? undefined : sid)
        lines.push(`- FQN=${row.fqn} module=${row.module}`)
        lines.push(`- 主文件：\`${workspacePath}\``)
        prereadRows.push(row)
        matches.push({ fqn: row.fqn, module: row.module, workspacePath })
      }
      lines.push('')
      continue
    }

    lines.push(`### ${hint} — 索引未命中（仍须在 scope 内搜索）`)
    lines.push(...buildMandatoryScopeSearchLines(hint, scopePrefixes, appScopeId, allowedScopeIds))
    lines.push('')
  }

  const preread = await buildClassSourcePrereadDirective(prereadRows)
  return { directive: `${lines.join('\n')}\n\n${preread}`, matches }
}

export async function buildOpencodeClassIndexDirective(
  message: string,
  appScopeId: string,
  allowedScopeIds: string[],
  classRefs: OpencodeClassRef[] = [],
) {
  const bundle = await buildOpencodeClassIndexBundle(message, appScopeId, allowedScopeIds, classRefs)
  return bundle.directive
}
