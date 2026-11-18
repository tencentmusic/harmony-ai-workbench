/** 索引/docs 不足时：必须查源码、用代码事实作答（工台 BFF / AGENTS 共用措辞） */

export function buildCodeFactsDirective(extraLine?: string) {
  const lines = [
    '**代码事实（硬规则）**',
    '业务知识 / 迁移案例 / L2 不足以回答时，**必须**在 [应用范围] 内 grep/read 项目源码后再作答。',
    '**禁止**用「通常」「一般」「配置中心优先」「页面重新拉取」等泛化经验代替源码证据。',
    '结论须含至少 1 条 `android-src/…` 或 `live-src/…` 路径，并说明类名/方法/ConfigKey/触发时机。',
  ]
  if (extraLine) lines.push(extraLine)
  return lines.join('\n')
}

export function buildKbMissDirective(grepHints: string[] = []) {
  const grepLine = grepHints.length
    ? `优先 grep：${grepHints.map((h) => `\`${h}\``).join('、')}`
    : '优先 grep 题干 URL path 段、ConfigKey、类名、业务关键词'
  return `[工台知识库未命中]
${buildCodeFactsDirective(`L1 无结构化主链 → 继续 L2（若适用）→ scope 内 ${grepLine} → read 源码后再作答。`)}

`
}
