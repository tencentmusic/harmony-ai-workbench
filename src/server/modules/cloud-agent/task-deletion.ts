import { attachmentIds } from './material-domain'
import { CloudError } from './domain'

const BUSY = new Set(['queued', 'running', 'cancelling', 'translation_queued', 'translating', 'review_queued', 'reviewing', 'delivery_queued', 'delivering'])

export interface TaskDeletionPlan {
  id: string
  appId: string
  identities: string[]
  branch: string
  integrationId: string
  attachmentIds: string[]
  artifactRoots: string[]
  harmonyRoots: string[]
  androidRoots: string[]
}

export function deletionPlan(row: { id: string; appId: string; revision: number; harnessJson: string; attachmentIds: string; attachments?: { id: string }[] }, actorId: string, creatorId: string | null, status: string, running: boolean): TaskDeletionPlan {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(row.id)) throw new CloudError('任务不存在或无权限', 404)
  if (!creatorId || creatorId !== actorId) throw new CloudError('只能删除自己创建的任务', 403)
  if (BUSY.has(status) || running) throw new CloudError('任务仍在执行，请先取消后再删除', 409)
  const saved = JSON.parse(row.harnessJson || '{}') as { workspace?: Record<string, unknown>; delivery?: { integrationId?: unknown } }
  const workspace = saved.workspace && typeof saved.workspace === 'object' ? saved.workspace : {}
  const identities = new Set<string>()
  for (let revision = 1; revision <= Math.min(Math.max(row.revision, 1), 50); revision += 1) identities.add(`${row.id}-${revision}`)
  const identity = typeof workspace.identity === 'string' ? workspace.identity : ''
  if (identity && !identities.has(identity)) throw new CloudError('任务工作区不属于当前任务，已停止删除', 409)
  const branch = typeof workspace.branch === 'string' ? workspace.branch : ''
  if (branch && branch !== `feature/cloud-${identity}`) throw new CloudError('任务分支不属于当前任务，已停止删除', 409)
  const integrationId = typeof saved.delivery?.integrationId === 'string' ? saved.delivery.integrationId : ''
  if (integrationId && integrationId !== `cloud-${row.id}`) throw new CloudError('提测记录不属于当前任务，已停止删除', 409)
  const text = (value: unknown) => typeof value === 'string' ? value : ''
  return { id: row.id, appId: row.appId, identities: [...identities], branch, integrationId,
    attachmentIds: [...new Set([...attachmentIds(JSON.parse(row.attachmentIds || '[]')), ...(row.attachments || []).map(item => item.id)])],
    artifactRoots: [text(workspace.artifactRoot)].filter(Boolean),
    harmonyRoots: [text(workspace.harmonyRoot)].filter(Boolean),
    androidRoots: [text(workspace.androidRoot)].filter(Boolean) }
}
