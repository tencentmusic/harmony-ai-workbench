/** KTV 业务接口 URL 定位 — ConversionJob 与 OpenCode 共用 */
import { listPortalKnowledgeWorkspaceRoots } from '@/lib/workspace-apps-config'

/** 各 App 内 URL 基础设施类（library 与 feature/inline 模块均可能存在） */
export const KTV_URL_CONTEXT_CLASS_NAMES = [
  'KtvUrlManager',
  'KtvUrlMap',
  'KtvConfigKeys',
  'KtvUrl',
  'KtvConstant',
  'KtvModuleConfigKeys',
  'KtvModuleUrlMgr',
  'KtvModuleUrl',
] as const

const KTV_URL_LOOKUP_RE =
  /KtvUrlManager|KtvUrlMap|KtvConfigKeys|KtvModuleConfigKeys|KtvModuleUrlMgr|KtvModuleUrl|ConfigKey|getKtv(Config|Sing7|Song|Full|Domain|Nsong).*Url|[A-Z][A-Za-z0-9]*Protocol|接口\s*url|接口URL|接口地址|请求地址|默认地址|默认\s*url|默认\s*URL|默认url|具体.*url|具体.*URL|后缀链接|播放链接|下载链接|业务接口|调用什么接口|调用了什么接口|接口\s*路径/i

const URL_BUSINESS_CLASS_RE =
  /(?:^|[\s(@])([A-Z][A-Za-z0-9]*(?:Protocol|Delegate))(?=[\s,.，。;；:：!?？)]|$)/g

const HTTP_URL_TEST_RE = /https?:\/\/[^\s"'<>]+/i
const HTTP_URL_SCAN_RE = /https?:\/\/[^\s"'<>]+/gi

/** @deprecated use HTTP_URL_TEST_RE / extractUrlPathGrepHints */
export const HTTP_URL_RE = HTTP_URL_TEST_RE

const ENGINEERING_FACT_RE =
  /(?:如何|怎么|怎样|是否|什么时|在哪).*(?:实现|更新|刷新|轮询|下发|自动|触发|调用|拉取|展示|频率|逻辑|机制|流程|代码|源码)|(?:自动|定时).*(?:更新|刷新|拉取)|接口.*(?:如何|怎么|怎样|谁|什么|更新|刷新|自动|作用|频率)|(?:安卓|Android).*(?:如何|怎么).*(?:更新|刷新|实现)|(?:谁调|在哪里|在哪儿|代码里|项目里|源码里|查一下.*实现)/i

const API_PATH_TOKEN_RE = /\bget[A-Z][A-Za-z0-9]+\b|\b[a-z]+service\b/i

export function isEngineeringFactQuestion(prompt?: string | null) {
  const text = String(prompt || '')
  return ENGINEERING_FACT_RE.test(text) || HTTP_URL_TEST_RE.test(text)
}

export function extractUrlPathGrepHints(message: string) {
  const hints: string[] = []
  const text = String(message || '')
  for (const m of text.matchAll(HTTP_URL_SCAN_RE)) {
    try {
      const u = new URL(m[0])
      for (const seg of u.pathname.split('/').filter((s) => s.length >= 3)) {
        hints.push(seg)
      }
      const hostHead = u.hostname.split('.')[0]
      if (hostHead && hostHead.length >= 2) hints.push(hostHead)
    } catch {
      // ignore malformed URL
    }
  }
  return [...new Set(hints)].slice(0, 8)
}

export function shouldUseKtvUrlLookup(prompt?: string | null) {
  const text = String(prompt || '')
  if (KTV_URL_LOOKUP_RE.test(text)) return true
  if (HTTP_URL_TEST_RE.test(text)) return true
  if (ENGINEERING_FACT_RE.test(text) && /接口|url|URL|http/i.test(text)) return true
  if (API_PATH_TOKEN_RE.test(text) && /接口|url|URL|path|service|config/i.test(text)) return true
  return false
}

export function extractUrlBusinessClassHints(message: string) {
  const text = String(message || '')
  const names: string[] = []
  for (const m of text.matchAll(URL_BUSINESS_CLASS_RE)) {
    const name = String(m[1] || '').trim()
    if (name) names.push(name)
  }
  return [...new Set(names)]
}

export function buildKtvUrlLookupRulesText() {
  const migrationRoots = listPortalKnowledgeWorkspaceRoots('migration')
  const migrationHint = migrationRoots.length
    ? migrationRoots.map((root) => `\`${root}/\``).join('、')
    : '已配置的迁移案例知识库'
  return `[接口 URL 定位 — 强制流程]
用户需要具体业务接口 URL / 后缀 / ConfigKey / 默认地址 / **接口在客户端如何刷新或更新** 时，**必须以 android-src 源码为最终事实**，禁止仅凭迁移案例或记忆作答。

权威顺序（高 → 低）：
1. \`android-src/\` / \`live-src/\` 内 grep URL path 段、ConfigKey、Protocol/Delegate（grep + read）
2. \`[工台知识库上下文]\` / \`harmony-kb/\` 结构化链（若有）
3. 共享 ${migrationHint} 仅作参考；**不得**作为 ConfigKey/URL/刷新机制的唯一证据

强制步骤（不可跳过）：
1. **grep** 题干 URL 的 path 段（如 \`getHeadline\`、\`rewardservice\`）与 \`ConfigKey\` / \`getKtvConfigUrl\` / 域名常量
2. 从用户提到的 **Protocol / Delegate / Fragment** 入手，在 [应用范围] 内 read 命中类，定位请求发起与刷新/轮询/事件触发代码
3. **read** 工台 \`[接口 URL 预检索 …]\` 给出的类；唱模块常见 \`KtvModuleConfigKeys\` / \`KtvModuleUrlMgr\`，音乐库常见 \`KtvConfigKeys\` / \`KtvUrlMap\`
4. 在 \`initMap()\` / \`putUrl(configKey, …)\` 查映射 → 在 ConfigKeys 查 key 字面量；**刷新机制**须 read 调用方（Timer/Observer/onResume/事件订阅），禁止空泛「配置中心/页面拉取」
5. 若读过迁移案例，须与源码 **对照**；不一致时 **以 android-src 为准**
6. 最终输出必须含 **android-src/… 或 live-src/… 证据路径**；禁止未 grep/read 就断言

`
}

export function buildKtvUrlContextSelectionHint() {
  return 'getKtvConfigUrl getKtvSing7NsongUrl ConfigKey 默认URL 接口地址'
}
