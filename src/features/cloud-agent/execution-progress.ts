import type { CloudEvent } from '@/contracts/cloud-agent'

export function executionEntries(events: CloudEvent[], runId?: string) {
  const ordered = [...new Map(events.filter(event => runId && event.runId === runId).map(event => [event.id, event])).values()].sort((a, b) => a.id - b.id)
  const entries: CloudEvent[] = []
  for (const event of ordered) {
    const last = entries.at(-1)
    if (event.kind === 'output' && last?.kind === 'output') last.message += event.message
    else entries.push({ ...event })
  }
  return entries.filter(event => event.message.trim())
}

export function isExecutionError(event: CloudEvent) {
  return ['failed', 'blocked', 'error'].includes(event.kind) || (event.kind === 'tool' && /失败|不得|不允许|非法|不存在|已变化|需处理返回问题|不可用|超时/.test(event.message))
}

export function humanInputReason(events: CloudEvent[], runId?: string) {
  return executionEntries(events, runId).filter(event => event.kind === 'continuation' && event.message.startsWith('需要补充外部事实：')).at(-1)?.message.slice('需要补充外部事实：'.length) || ''
}

const tools: Record<string, string> = {
  source_list: '定位源码文件', source_read: '读取源码', harness_rule: '读取 Harness 规则',
  harness_record: '登记证据与验收清单', harness_status: '校验流程门禁', harness_start: '初始化迁移档案',
  artifact_read: '读取任务材料', candidate_inspect: '检查候选材料', candidate_write: '保存候选材料',
  video_frames: '抽取录屏画面', knowledge_query: '检索知识库', knowledge_read: '读取知识文档',
}
export function executionLabel(message: string) {
  return message.replace(/^(调用|完成) (\w+)/, (match, action: string, tool: string) => tools[tool] ? `${action === '调用' ? '开始' : '完成'}${tools[tool]} (${tool})` : match)
}
