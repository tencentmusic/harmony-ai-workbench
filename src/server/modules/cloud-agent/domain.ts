import type { CloudAction, CloudAnalysis, CloudStatus } from '@/contracts/cloud-agent'
import { attachmentIds } from './material-domain'

export class CloudError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export class CloudRecoveryError extends CloudError {}
export class CloudEnvironmentError extends CloudError {}
export class CloudTransientError extends CloudError {}
export class CloudReviewYieldError extends CloudError {}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudError('无效请求')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max: number, optional = false): string {
  if (value === undefined && optional) return ''
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new CloudError(`${label}格式错误或过长`)
  return value.trim()
}
export function validBranch(value: string): boolean {
  return value.length > 0 && value.length <= 180 && !value.startsWith('-') && !value.startsWith('refs/') && value !== '@' &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}
export function parseTaskInput(value: unknown) {
  const row = record(value)
  const appId = text(row.appId, 'App', 80)
  const targetBranch = text(row.targetBranch, '分支', 180)
  if (!validBranch(targetBranch)) throw new CloudError('分支名称非法')
  const ids = attachmentIds(row.attachmentIds)
  const material = text(row.material, '需求材料', 60_000, true)
  if (!material && !ids.length) throw new CloudError('请填写文字或上传附件')
  return { appId, targetBranch, title: text(row.title, '需求标题', 160), material, attachmentIds: ids }
}
export function parseDecision(value: unknown) {
  const row = record(value)
  const action = row.action as CloudAction
  if (!['approve', 'retry', 'cancel', 'translate', 'resume_translation', 'submit_delivery', 'confirm_delivery', 'sync_delivery', 'publish_knowledge', 'rework'].includes(action)) throw new CloudError('操作非法')
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw new CloudError('缺少当前版本')
  const digest = text(row.digest, '产物摘要', 64, true)
  if (action === 'approve' && !/^[a-f0-9]{64}$/.test(digest)) throw new CloudError('批准必须绑定产物摘要')
  const reason = text(row.reason, '说明', 2000, true)
  if (action === 'rework' && !reason) throw new CloudError('请填写返修原因和验收要求')
  return { action, revision: Number(row.revision), digest, reason }
}
const transitions: Record<CloudStatus, CloudStatus[]> = {
  delivery_ready: ['delivery_queued', 'cancelled'], device_concluded: ['delivery_queued', 'cancelled'], delivery_queued: ['delivering', 'cancelled'], delivering: ['awaiting_merge', 'knowledge_review', 'completed', 'harness_waiting', 'failed', 'blocked', 'cancelling'], awaiting_merge: ['delivery_queued', 'cancelled'], knowledge_review: ['delivery_queued', 'cancelled'], completed: [],
  queued: ['running', 'cancelled'], running: ['awaiting_input', 'awaiting_approval', 'blocked', 'failed', 'cancelling'],
  awaiting_input: ['queued', 'cancelled'], awaiting_approval: ['review_queued', 'queued', 'awaiting_input', 'cancelled'],
  approved: ['translation_queued', 'queued', 'awaiting_input', 'cancelled'], blocked: ['queued', 'cancelled'], failed: ['queued', 'cancelled'],
  cancelling: ['cancelled', 'blocked'], cancelled: [],
  translation_queued: ['translating', 'cancelled'], translating: ['harness_waiting', 'code_ready', 'delivery_ready', 'device_concluded', 'awaiting_approval', 'blocked', 'failed', 'cancelling'],
  harness_waiting: ['translation_queued', 'queued', 'cancelled'], code_ready: ['translation_queued', 'queued', 'cancelled'],
  review_queued: ['reviewing', 'cancelled'], reviewing: ['awaiting_input', 'awaiting_approval', 'approved', 'translation_queued', 'failed', 'cancelling'],
}
export function canTransition(from: CloudStatus, to: CloudStatus) { return transitions[from]?.includes(to) ?? false }
export function actionsFor(status: CloudStatus, kind?: string): CloudAction[] {
  if (status === 'completed') return []
  if (status === 'delivery_ready' || status === 'device_concluded') return ['submit_delivery', 'cancel']
  if (status === 'awaiting_merge') return ['sync_delivery', 'publish_knowledge', 'rework', 'cancel']
  if (status === 'knowledge_review') return ['sync_delivery', 'cancel']
  if (status === 'delivery_queued' || status === 'delivering') return ['cancel']
  if (kind === 'delivery' && ['blocked', 'failed'].includes(status)) return ['submit_delivery', 'sync_delivery', 'publish_knowledge', 'rework', 'cancel']
  if (status === 'cancelled' || status === 'cancelling') return []
  if (kind === 'translation' && ['blocked', 'failed'].includes(status)) return ['resume_translation', 'retry', 'cancel']
  if (['translation_queued', 'translating', 'review_queued', 'reviewing'].includes(status)) return ['cancel']
  if (status === 'approved') return ['translate', 'retry', 'cancel']
  if (status === 'harness_waiting' || status === 'code_ready') return ['resume_translation', 'retry', 'cancel']
  if (status === 'running' || status === 'queued') return ['cancel']
  if (status === 'awaiting_approval') return ['approve', 'retry', 'cancel']
  return ['retry', 'cancel']
}
export function parseAnalysis(raw: string): CloudAnalysis {
  if (raw.length > 120_000) throw new CloudError('分析结果超出上限')
  let parsed: unknown
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) } catch { throw new CloudError('模型未返回结构化分析结果') }
  const row = record(parsed)
  const list = (key: string, allowEmpty = false) => {
    const items = row[key]
    if (!Array.isArray(items) || items.length > 80 || (!allowEmpty && items.length === 0)) throw new CloudError(`分析缺少 ${key}`)
    return items.map(item => text(item, key, 8000))
  }
  return { summary: text(row.summary, '摘要', 12000), requirements: list('requirements'), approach: list('approach'), acceptance: list('acceptance'), questions: list('questions', true) }
}
export function analysisMarkdown(value: CloudAnalysis) {
  return `## 需求摘要\n\n${value.summary}\n\n` + ([['需求范围', value.requirements], ['实现方案', value.approach], ['验收标准', value.acceptance], ['待确认问题', value.questions]] as const)
    .map(([title, items]) => `## ${title}\n\n${items.length ? items.map(item => `- ${item}`).join('\n') : '无'}\n`).join('\n')
}
export function parseMergedEvent(value: unknown) {
  const row = record(value)
  if (row.object_kind !== 'merge_request') return null
  const attrs = record(row.object_attributes)
  if (attrs.state !== 'merged') return null
  const project = record(row.project)
  if (!Number.isSafeInteger(project.id) || Number(project.id) < 1 || !Number.isSafeInteger(attrs.iid) || Number(attrs.iid) < 1) throw new CloudError('MR 身份不完整')
  let url: URL
  try { url = new URL(text(project.web_url, '仓库 URL', 1000)) } catch { throw new CloudError('MR 仓库 URL 非法') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CloudError('MR 仓库 URL 非法')
  const branch = text(attrs.target_branch, '目标分支', 180)
  if (!validBranch(branch)) throw new CloudError('MR 分支非法')
  const sourceBranch = typeof attrs.source_branch === 'string' && validBranch(attrs.source_branch) ? attrs.source_branch : undefined
  const commit = attrs.last_commit && typeof attrs.last_commit === 'object' ? record(attrs.last_commit) : {}
  const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) ? value : undefined
  return { origin: `https://${url.host}`, repository: url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''), projectId: Number(project.id), iid: Number(attrs.iid), branch,
    sourceBranch, sourceSha: sha(commit.id), mergedSha: sha(attrs.merge_commit_sha) || sha(attrs.squash_commit_sha), sourceProjectId: attrs.source_project_id,
    baseSha: sha(attrs.diff_refs && typeof attrs.diff_refs === 'object' ? record(attrs.diff_refs).base_sha : undefined),
    title: typeof attrs.title === 'string' ? attrs.title.slice(0, 160) : '', description: typeof attrs.description === 'string' ? attrs.description.slice(0, 12000) : '' }
}
