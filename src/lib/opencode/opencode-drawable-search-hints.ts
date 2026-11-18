/** 嵌套模块的资源路径由 workspace 配置提供，不在源码中维护业务仓库名称。 */
const NESTED_RES_NOTES: Record<string, string> = {}

export function extractDrawableNameHints(message: string) {
  const names = new Set<string>()
  const text = String(message || '')
  for (const m of text.matchAll(/@drawable\/([a-z0-9_]+)/gi)) names.add(m[1])
  for (const m of text.matchAll(/R\.drawable\.([a-z0-9_]+)/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b(fa_[a-z0-9_]{3,})\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b(fx_[a-z0-9_]{3,})\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b(ktv_[a-z0-9_]{3,})\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b(ic_[a-z0-9_]{3,})\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b(btn_[a-z0-9_]{3,})\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/\b([a-z0-9_]+)\.(webp|png|jpe?g|gif)\b/gi)) names.add(m[1])
  for (const m of text.matchAll(/drawable[^/\\]*[/\\]([a-z0-9_]+)\.(webp|png|jpe?g|gif)/gi)) names.add(m[1])
  return [...names]
}

export function hasBitmapFilenameHint(message: string) {
  return /\b[a-z0-9_]+\.(webp|png|jpe?g|gif)\b/i.test(String(message || ''))
}

export function inferDrawableNamePrefix(message: string) {
  const text = String(message || '')
  if (/playopus|bottom_bar|PlayOpus|作品播放|底部栏|ktv_playopus/i.test(text)) return 'ktv_playopus'
  if (/sharepopup|分享图标|分享.*icon/i.test(text)) return 'ic_sharepopup'
  if (/comm_share_logo/i.test(text)) return 'comm_share_logo'
  if (
    !/给我返回|返回给我|把这个.*返回|图片.*返回/i.test(text) &&
    /返回(?:键|按钮|图标|icon|图)|(?:导航|标题).*(?:返回|back)|back.*(?:btn|button|icon)|btn_titile_back|titile.*back/i.test(
      text,
    )
  ) {
    return 'btn_titile_back'
  }
  if (/业务.*图标|图标.*业务|图标原图/i.test(text)) return 'ktv_playopus'
  return null
}

/** 精确名或 animation-list 帧名（base_00、base_01…） */
export function matchesDrawableResourceName(baseName: string, wantedName: string) {
  const base = baseName.toLowerCase()
  const wanted = wantedName.toLowerCase()
  if (base === wanted) return true
  if (base.startsWith(`${wanted}_`)) return true
  return false
}

function normalizeScopePrefix(prefix: string) {
  return prefix.replace(/\\/g, '/').replace(/\/+$/g, '')
}

/** 展示用：保持配置中的模块顺序，避免 Agent 只搜第一个标准前缀。 */
export function prioritizeDrawableSearchPrefixes(scopePrefixes: string[]) {
  const prefixes = scopePrefixes.map(normalizeScopePrefix).filter(Boolean)
  return [...prefixes]
}

function buildPrefixDrawablePatterns(prefix: string, resourceName: string, workspaceAlias: string) {
  const p = normalizeScopePrefix(prefix)
  return [
    `${workspaceAlias}/${p}/src/main/res/drawable-<density>/${resourceName}.webp`,
    `${workspaceAlias}/${p}/src/main/res/drawable-<density>/${resourceName}.png`,
    `${workspaceAlias}/${p}/**/res/drawable-<density>/${resourceName}.*`,
  ]
}

/** Agent 侧 glob/read 指引（避免 brace expansion 与无 scope 的 ** 全库递归）。 */
export function buildDrawableAgentSearchLines(
  scopePrefixes: string[],
  resourceNames: string[] = [],
  workspaceAlias = 'android-src',
) {
  const prefixes = prioritizeDrawableSearchPrefixes(scopePrefixes)
  const resourceName = resourceNames[0] || '<资源名>'
  const listedPrefixes = prefixes.length <= 6 ? prefixes : prefixes.slice(0, 4)

  const scopedPatterns = listedPrefixes.flatMap((prefix) =>
    buildPrefixDrawablePatterns(prefix, resourceName, workspaceAlias),
  )

  const lines = [
    '**glob 约束（OpenCode 工具限制）：**',
    '- **禁止** `{webp,png,jpg}` 等 brace expansion（不支持）',
    `- **禁止**首轮无 scope 的 \`${workspaceAlias}/**/drawable-*dpi/**\` 大范围 ** 递归`,
    '- **优先** [应用范围] 内具体模块前缀 + 密度目录（位图不在 `drawable/` 根目录）',
    '- **禁止**只搜 scope 第一个前缀就断言不存在；须对 [应用范围] 内各前缀逐个 glob',
    '',
    '**推荐 pattern（按资源名逐个 glob，扩展名分开写或用 `.*`）：**',
    ...scopedPatterns.map((pattern) => `- \`${pattern}\``),
  ]

  if (prefixes.length > listedPrefixes.length) {
    lines.push(
      `- 其余 ${prefixes.length - listedPrefixes.length} 个 scope 前缀：对每个前缀 glob \`${workspaceAlias}/<前缀>/**/res/drawable-<density>/${resourceName}.*\`（完整列表见 [应用范围]）`,
    )
  }

  for (const prefix of prefixes) {
    const note = NESTED_RES_NOTES[normalizeScopePrefix(prefix)]
    if (note) lines.push(`- **${prefix}**：${note}`)
  }

  lines.push(
    '- 部分模块位图在 `src/middleWareMain/res/` 等非 `src/main/res/` 路径 → 用 `/**/res/drawable-<density>/` 兜底',
    '',
    '**glob 0 命中 fallback（必做，read 列目录比大范围 glob 更可靠）：**',
    `1. 对 [应用范围] 内**每个**前缀依次 glob \`${workspaceAlias}/<前缀>/**/res/drawable-<density>/${resourceName}.*\``,
    `2. 仍 0 命中则 read 各前缀下 \`.../res/drawable-<density>/\` 目录列表（含 nested 子模块）`,
    `3. 未列完所有 scope 前缀前 **禁止**断言「全 scope 不存在」`,
    `4. 定位文件后输出 \`![名](opencode-asset:${workspaceAlias}/.../xxx.webp)\`，不要猜 density；仅 \`.xml\` 则说明矢量/shape`,
    '5. **animation-list 帧动画**：先读取对应 `drawable/*.xml`，再按其中的帧名查找 `drawable-<density>/` 位图。',
    '',
  )

  return lines
}
