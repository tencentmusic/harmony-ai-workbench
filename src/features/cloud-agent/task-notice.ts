import type { CloudAction, CloudStatus } from '@/contracts/cloud-agent'

interface NoticeInput {
  status: CloudStatus
  actions: CloudAction[]
  error: string
  sourceIssues: string[]
  recoveryRequired: boolean
  inputReason: string
}
export interface TaskNoticeValue {
  type: 'warning' | 'error'
  title: string
  reason: string
  next: string
  details: string
}
const brief = (text: string) => text.length > 140 ? `${text.slice(0, 140)}…` : text

export function taskNotice(input: NoticeInput): TaskNoticeValue | null {
  const stopped = ['harness_waiting', 'awaiting_input', 'blocked', 'failed'].includes(input.status)
  const error = stopped || input.recoveryRequired ? input.error.trim() : ''
  const details = [input.sourceIssues.length ? `源码环境：\n${input.sourceIssues.join('\n')}` : '', input.inputReason, error].filter(Boolean).filter((item, i, all) => all.indexOf(item) === i).join('\n\n')
  const next = input.actions.includes('resume_translation') ? '处理阻塞条件后，在当前环节底部选择“继续 Harness”，沿原分支继续。'
    : input.actions.includes('retry') ? '处理问题后，在当前环节底部选择“继续分析”。'
      : '查看“执行过程”定位未完成步骤；当前没有可直接继续的操作。'
  if (input.recoveryRequired) return { type: 'warning', title: '执行中断，待管理员恢复', reason: '旧进程或未完成操作的状态尚未确认，已锁定继续执行。', next: '请管理员核验进程与执行记录并解除恢复锁；无需重新审批需求。', details }
  if (input.sourceIssues.length) return { type: 'error', title: '源码环境未就绪', reason: brief(input.sourceIssues[0]), next: '请维护人员恢复源码目录或配置，待环境检查通过后继续。', details }
  if (!stopped) return null
  if (input.status === 'awaiting_input' && input.inputReason) return { type: 'warning', title: '待补充业务信息', reason: brief(input.inputReason), next: '在当前环节底部选择“补充资料 / 提出修改”，补齐信息后提交。', details }
  const reason = /连续\s*\d+\s*轮.*没有新证据|无.*进展保护|连续.*无新工程进展/.test(error)
    ? '连续多轮未产生新证据，触发无进展保护，已有进度已保留。'
    : error ? brief(error.split(/[。\n]/)[0]) : '本轮未完成当前步骤，尚不具备进入下一阶段的条件。'
  return { type: input.status === 'failed' || input.status === 'blocked' ? 'error' : 'warning',
    title: input.status === 'harness_waiting' ? '执行已暂停，等待继续' : input.status === 'awaiting_input' ? '分析尚未完成' : input.status === 'failed' ? '本轮执行失败' : '执行受阻',
    reason, next, details }
}
