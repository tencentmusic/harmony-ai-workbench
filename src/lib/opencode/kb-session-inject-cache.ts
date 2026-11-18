type CachedFeatureInject = {
  feature_id: string
  call_chain_rel: string
  artifacts: string[]
  android_entry_simple?: string
  title?: string
  injected_at: number
}

const byChatSession = new Map<string, Map<string, CachedFeatureInject>>()

function sessionMap(chatSessionId: string) {
  let map = byChatSession.get(chatSessionId)
  if (!map) {
    map = new Map()
    byChatSession.set(chatSessionId, map)
  }
  return map
}

export function hasKbSessionInject(chatSessionId: string | undefined, featureId: string) {
  if (!chatSessionId || !featureId) return false
  return sessionMap(chatSessionId).has(featureId)
}

export function recordKbSessionInject(
  chatSessionId: string | undefined,
  record: Omit<CachedFeatureInject, 'injected_at'>,
) {
  if (!chatSessionId || !record.feature_id) return
  sessionMap(chatSessionId).set(record.feature_id, {
    ...record,
    injected_at: Date.now(),
  })
}

export function clearKbSessionInjectCache(chatSessionId: string | undefined) {
  if (!chatSessionId) return
  byChatSession.delete(chatSessionId)
}

export function formatSessionContinueDirective(record: CachedFeatureInject) {
  const chainPath = `harmony-kb/${record.call_chain_rel.replace(/\\/g, '/')}`
  const lines = [
    '[工台知识库上下文 · 续聊]',
    `feature_id: ${record.feature_id}`,
    `说明: 本会话上一轮已注入「${record.feature_id}」完整主链与双端映射，勿重复 read ${chainPath}。`,
    `基于上文继续作答；**未覆盖的细节必须先** kb_codegraph_search / kb_codegraph_callers（L2）；L2 不满意再 scope 内 grep，仍不足再 scoped read。`,
    `详表路径: ${chainPath}`,
  ]
  if (record.android_entry_simple) {
    lines.push(`Android 入口: ${record.android_entry_simple}`)
  }
  if (record.title) {
    lines.push(`功能: ${record.title}`)
  }
  lines.push('禁止无范围全库 glob/grep；禁止忽视上文重复读取同一 KB 详表。\n')
  return `${lines.join('\n')}\n`
}

export function resetKbSessionInjectCacheForTests() {
  byChatSession.clear()
}
