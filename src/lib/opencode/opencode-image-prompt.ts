import type { OpencodeImageRef } from '@/lib/opencode/opencode-image'
import {
  buildOpencodeDrawablePresearchDirective,
} from '@/lib/opencode/opencode-drawable-resolver'
import {
  buildDrawableAgentSearchLines,
  extractDrawableNameHints,
  hasBitmapFilenameHint,
} from '@/lib/opencode/opencode-drawable-search-hints'
import { getAppScopeSearchPrefixes, resolveRequestedAppScopeId } from '@/lib/opencode/opencode-app-scope'
import { getAndroidAppScopeWorkspaceAlias } from '@/lib/android-app-scopes'

const ICON_INTENT_RE =
  /(?:原图|图标|icon|drawable|mipmap|webp|png|jpe?g|\.9\.png|资源图|配图|分享.*图|图.*资源|返回.*图|展示.*图|看.*图|所有.*图标|业务.*图标|图标.*业务|这个图片|给我返回|返回给我|下载.*\.(?:webp|png|jpe?g|gif))/i

const ICON_NAME_LIST_RE =
  /\b(?:ic_[\w]+|btn_[\w]+|comm_[\w]+(?:_selector)?|ktv_[\w]+)\b/i

export function isOpencodeImageIntent(message: string) {
  const text = String(message || '').trim()
  if (!text) return false
  if (ICON_INTENT_RE.test(text)) return true
  if (hasBitmapFilenameHint(text)) return true
  if (extractDrawableNameHints(text).length > 0 && /drawable|mipmap|res\/|资源|图标|原图/i.test(text)) {
    return true
  }
  if (ICON_NAME_LIST_RE.test(text) && /分享|share|drawable|mipmap|图标|原图|playopus/i.test(text)) {
    return true
  }
  return false
}

function buildOpencodeImageDirectiveText(userMessage: string, scopePrefixes: string[], workspaceAlias: string) {
  const text = String(userMessage || '')
  const shareHint = /分享|share|ic_sharepopup|comm_share_logo/i.test(text)
  const playopusHint = /playopus|bottom_bar|PlayOpus|业务.*图标|底部栏/i.test(text)
  const names = extractDrawableNameHints(text)

  const lines = [
    '[图标原图展示 — 强制流程]',
    '用户需要**在对话里看到可下载/可预览的位图**；工台**只认** Markdown `![名](opencode-asset:…)`，**不认**口头「已返回/已给出」。',
    '',
    '**与 L2 CodeGraph 分工（硬性）**：',
    '- **禁止** `kb_codegraph_search` / `kb_codegraph_explore` / `codegraph query` 查找 webp/png/jpg 位图或 `@drawable/xxx` 原图',
    '- CodeGraph **不索引** Android `res/drawable*` / `mipmap*` 目录与二进制图片（内置 ignore + 无图片 grammar）',
    '- 位图检索**只能**走：工台 `[drawable 预检索 …]` → scope 内 glob/read 密度目录 → 输出 opencode-asset',
    '- 若需知「谁引用了 @drawable/xxx」→ 可 grep layout/Java/xml；**返回原图**仍须 glob/read 位图文件',
    '',
    '**必须按顺序执行，禁止跳过：**',
    '1. 从用户消息、layout/Java 收集 `@drawable/xxx`、`R.drawable.xxx`、或 `xxx.webp` 等资源名/文件名',
    ...buildDrawableAgentSearchLines(scopePrefixes, names, workspaceAlias),
    shareHint ? '分享相关：优先 glob `ic_sharepopup_*`、`comm_share_logo*`（scoped + drawable-<density> 等）' : null,
    playopusHint ? 'playopus 底部栏：优先 glob `ktv_playopus_*`（scoped + drawable-<density> 等）' : null,
    `**命中位图后（硬性）**：每个文件一条 \`![文件名](opencode-asset:${workspaceAlias}/.../drawable-<density>/xxx.webp)\``,
    '工台 `[drawable 预检索 …]` 已列出的路径 → **必须全部**输出为 opencode-asset 图片，**禁止**只复述路径或说「已返回」',
    '若仅有 `drawable/xxx.xml` 无位图 → 说明是矢量/shape/Lottie，**不要**说 png/webp 不存在',
    '**禁止**只列资源名、禁止 HTML `<img>`/base64、禁止未检索就断言文件不存在',
    '',
    '**反例（禁止）：**',
    `- 只说「已返回 fa_default_medal.webp」但正文无 \`![...](opencode-asset:...)\``,
    '- 使用 `.{webp,png,jpg}` brace expansion 或首轮无 scope 大范围 `**` glob',
    '- 只输出资源名列表，没有 opencode-asset 图片',
    '',
  ].filter(Boolean) as string[]

  return `${lines.join('\n')}\n`
}

export async function augmentOpencodeMessageWithImageDirective(
  userMessage: string,
  appScopeId: string,
  allowedScopeIds: string[],
) {
  if (!isOpencodeImageIntent(userMessage)) {
    return { directive: '', presearchImages: [] as OpencodeImageRef[] }
  }

  const scopePrefixes = getAppScopeSearchPrefixes(appScopeId, allowedScopeIds)
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds)
  const workspaceAlias =
    sid && sid !== 'all' ? getAndroidAppScopeWorkspaceAlias(sid) : 'android-src'
  const presearch = await buildOpencodeDrawablePresearchDirective(userMessage, scopePrefixes, sid === 'all' ? appScopeId : sid)
  const base = buildOpencodeImageDirectiveText(userMessage, scopePrefixes, workspaceAlias)
  return {
    directive: `${base}${presearch.directive}`,
    presearchImages: presearch.images,
  }
}
