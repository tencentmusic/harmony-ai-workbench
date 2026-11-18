import { createHash } from 'node:crypto'
import { CloudError, record } from './domain'
import { CLOUD_STAGES, HARNESS_STAGE, cloudStageForStatus, type CloudStatus } from '@/contracts/cloud-agent'

export interface NotificationTask { id: string; title: string; appId: string; revision: number; materialVersion: number; status: string; stage?: string; harnessJson: string; handoffStatus?: string }
export interface Recipient { userId?: string; mobile?: string }
export const notificationStatuses = ['awaiting_approval', 'awaiting_input', 'harness_waiting', 'blocked', 'failed', 'approved', 'code_ready', 'awaiting_merge', 'knowledge_review']
export function notificationState(task: NotificationTask) {
  if (!notificationStatuses.includes(task.status)) return null
  const saved = record(JSON.parse(task.harnessJson)), review = record(saved.review || {}), delivery = record(saved.delivery || {})
  const status = task.status
  if (status === 'awaiting_merge' && delivery.codeMerged === true && !delivery.knowledge) return null
  let reason = '', next = ''
  if (status === 'awaiting_approval') {
    const gate = review.kind === 'ui' ? 'UI 基线' : review.kind === 'visual' ? '真机视觉' : '需求范围'
    reason = `${gate}等待人工审批`; next = '打开任务审核当前材料，确认或提出修改'
  } else if (status === 'awaiting_input') { reason = '需要补充材料或业务信息'; next = '查看待确认问题，补充资料后继续' }
  else if (status === 'awaiting_merge') {
    if (task.handoffStatus === 'submitted') return null
    reason = delivery.confirmationError ? '确认提测失败，集成单待核对' : task.handoffStatus === 'closed' || task.handoffStatus === 'missing' ? '提测记录待核对' : '特性分支已发布，待开发本地复核'
    next = delivery.confirmationError ? '核对集成记录后重新确认提测；已发布分支和验收记录保留，无需重跑转译' : '拉取特性分支，本地修复与验收后确认提测，届时自动创建集成单；无需重跑转译'
  }
  else if (status === 'knowledge_review') { reason = '知识回流 MR 已创建'; next = '审核知识文档 MR，合入后自动核实发布状态' }
  else { reason = '流程未完成，需要处理当前待办'; next = '查看任务当前状态、停止原因和下一步操作；无需重开需求' }
  const stable = status === 'awaiting_merge' || status === 'knowledge_review'
  const scope = stable ? [delivery.integrationId, record(delivery.codeSnapshot || {}).sha, record(delivery.knowledge || {}).url] : [task.revision, task.materialVersion, review.digest]
  const key = createHash('sha256').update(JSON.stringify([status, ...scope, ...(delivery.confirmationError ? ['confirmation_failed'] : [])])).digest('hex')
  const native = record(saved.status || {}), lifecycle = record(native.lifecycle || {})
  const stageId = task.stage || lifecycle.stage || HARNESS_STAGE[native.phase as keyof typeof HARNESS_STAGE]
  const stage = CLOUD_STAGES.find(item => item.id === stageId)?.label || cloudStageForStatus(status as CloudStatus)?.label || '待确认'
  return { key, reason, next, stage }
}
export function notificationRecipient(code: string | null, mappings: Record<string, unknown>, fallback: unknown): Recipient {
  const value = record(code && Object.hasOwn(mappings, code) ? mappings[code] : fallback)
  if (typeof value.userId === 'string' && /^[a-zA-Z0-9_.@-]{1,100}$/.test(value.userId) && value.userId !== '@all') return { userId: value.userId }
  if (typeof value.mobile === 'string' && /^\+?\d{6,20}$/.test(value.mobile)) return { mobile: value.mobile }
  throw new CloudError('企业微信接收人尚未配置', 503)
}
function utf8Clip(value: string, limit: number) {
  let result = '', bytes = 0
  for (const char of value) { bytes += Buffer.byteLength(char); if (bytes > limit) break; result += char }
  return result
}
export function notificationPayload(task: NotificationTask, state: NonNullable<ReturnType<typeof notificationState>>, recipient: Recipient, base: string, appLabel = task.appId) {
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) || base.length > 500) throw new CloudError('通知需配置团队可访问的工作台地址', 503)
  url.pathname = '/dashboard'; url.search = '?tab=cloud-agent'; url.hash = ''
  url.searchParams.set('cloudTask', task.id)
  const content = `转译任务待办\n任务：${utf8Clip(task.title.replace(/[\r\n]/g, ' '), 400)}\n应用：${utf8Clip(appLabel.replace(/[\r\n]/g, ' '), 200)}\n当前环节：${state.stage}\n编号：${task.id}\n状态：${state.reason}\n下一步：${state.next}\n${url.href}`
  if (Buffer.byteLength(content) > 2048) throw new CloudError('通知内容过长', 503)
  return { msgtype: 'text', text: { content, ...(recipient.userId ? { mentioned_list: [recipient.userId] } : { mentioned_mobile_list: [recipient.mobile!] }) } }
}
export function validateWecomWebhook(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.host !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' || url.username || url.password || url.hash || !url.searchParams.get('key') || [...url.searchParams.keys()].some(key => key !== 'key') || url.searchParams.getAll('key').length !== 1) throw new CloudError('企业微信 Webhook 配置非法', 503)
  return url
}
