import { createIntegrationTask, getIntegrationTask, listIntegrationHandoffs } from '@/server/modules/integration/public'
import type { CloudTask, CloudHandoff } from '@/contracts/cloud-agent'
import { CloudError } from './domain'

export function handoffDescription(input: { taskId: string; identity: string; sha: string; documents: string; deviceConclusion?: { result: string; reason: string } }) {
  const outcome = input.deviceConclusion?.result === 'incomplete' ? `设备验收结论：未完成；${input.deviceConclusion.reason.replaceAll('\n', ' ').slice(0, 1000)}\n未完成项须由开发本地复核，不代表 Harness 交付通过。` : '设备验收结论：Harness 严格交付门禁通过。'
  return `云Agent任务：${input.taskId}\nHarness：${input.identity}\n验收快照：${input.sha}\n分支文档：${input.documents}\n${outcome}\n开发接手后在本地修复和验收，代码MR由团队流程创建。`
}

export async function registerIntegrationHandoff(input: {
  id: string; taskId: string; title: string; appId: string; branch: string; target: string; sha: string; identity: string; documents: string; creatorId: string | null; deviceConclusion?: { result: string; reason: string }
}, dependencies = { get: getIntegrationTask, create: createIntegrationTask }) {
  const projectId = `app-${input.appId.toLowerCase()}`
  let task = await dependencies.get(input.id)
  if (!task) task = await dependencies.create({ id: input.id, title: input.title, projectId, sourceBranch: input.branch, targetBranch: input.target,
    featureDesc: handoffDescription(input), createdByTokenId: input.creatorId })
  if (task.sourceBranch !== input.branch || task.targetBranch !== input.target || task.projectId !== projectId || !task.featureDesc?.includes(`验收快照：${input.sha}\n`)) throw new CloudError('既有集成记录与当前交付快照不一致', 409)
  return task
}

export async function handoffsFor(rows: { id: string; harnessJson: string }[]) {
  const states = rows.map(row => ({ id: row.id, saved: JSON.parse(row.harnessJson) }))
  const ids = states.flatMap(({ saved }) => typeof saved.delivery?.integrationId === 'string' ? [saved.delivery.integrationId] : [])
  const records = new Map((ids.length ? await listIntegrationHandoffs(ids) : []).map(item => [item.id, item]))
  return new Map(states.map(({ id, saved }) => {
    const delivery = saved.delivery
    if (!delivery?.integrationId) return [id, delivery?.codeCandidate && delivery.codeSnapshot?.sha ? { status: 'pending' as const, ...(typeof delivery.confirmationError === 'string' ? { error: delivery.confirmationError } : {}) } : undefined] as const
    const item = records.get(delivery.integrationId), candidate = delivery.codeCandidate || delivery.code
    const matched = item && candidate && item.sourceBranch === candidate.branch && item.targetBranch === candidate.target && item.featureDesc?.includes(`验收快照：${delivery.codeSnapshot?.sha}\n`)
    const event = item?.events[0]
    const handoff: CloudHandoff = { status: !matched ? 'missing' : item.status === 'closed' ? 'closed' : ['submitted', 'merge_pending', 'merged'].includes(item.status) ? 'submitted' : 'pending',
      ...(typeof delivery.confirmationError === 'string' ? { error: delivery.confirmationError } : {}),
      ...(matched && event ? { submittedAt: event.createdAt.toISOString(), submittedBy: event.actorToken?.personName || '开发人员' } : {}) }
    return [id, handoff] as const
  }))
}

export function deliveryDto(saved: Record<string, unknown>, handoff?: CloudHandoff): CloudTask['delivery'] {
  const delivery = saved.delivery as { code?: { url?: string; sha?: string }; priorCode?: { url?: string }; knowledge?: { url?: string }; codeCandidate?: { origin: string; repository: string; branch: string; target: string }; integrationId?: string; codeSnapshot?: { sha: string }; codeMerged?: boolean } | undefined
  if (!delivery) return undefined
  const workspace = saved.workspace as { documentsPath?: string; appId?: string; identity?: string } | undefined
  const candidate = delivery.codeCandidate
  return { codeUrl: delivery.code?.url || delivery.priorCode?.url, knowledgeUrl: delivery.knowledge?.url, integrationId: delivery.integrationId,
    codeMerged: delivery.codeMerged === true, frozen: !!delivery.codeSnapshot || !!delivery.priorCode, handoff,
    repositoryUrl: candidate ? `${candidate.origin}/${candidate.repository}` : undefined, branch: candidate?.branch, target: candidate?.target,
    acceptedSha: delivery.codeSnapshot?.sha, mergedSourceSha: delivery.codeMerged ? delivery.code?.sha : undefined,
    documentsPath: workspace?.identity && workspace.appId ? `${workspace.documentsPath || 'docs/migrations'}/${workspace.appId}/${workspace.identity}` : undefined }
}
