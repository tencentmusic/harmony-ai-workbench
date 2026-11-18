import { prisma } from '@/lib/prisma'
import { executionConfig } from './execution-config'
import { CloudTransientError, record } from './domain'
import { findDeliveryMR, mergedMR, type DeliveryMR } from './delivery-git'
import { gitlabRequestFor, type GitLabRequest } from './gitlab-access'
import { finishCloudRun, type claimCloudRun } from './store'
import { cloudProject } from './config'
import { resolveKnowledgeBase, loadWorkspaceAppsConfig } from '@/lib/workspace-apps-config'
import { mergedByWebhook, mergeEventMatches } from './delivery-ssh'
import { handoffsFor } from './delivery-handoff'

async function sshDeliveryNeedsRun(appId: string, saved: Record<string, unknown>, signal: AbortSignal) {
  const delivery = record(saved.delivery || {}), code = (delivery.code || delivery.codeCandidate) as DeliveryMR | undefined
  if (!code) return false
  if (!delivery.codeMerged && !await mergedByWebhook(cloudProject(appId).harmonyRoot, code, signal, code.iid, record(delivery.codeSnapshot || {}).base as string | undefined, !!delivery.integrationId)) return false
  if (!delivery.knowledge) return true
  const settings = executionConfig(appId).delivery!
  const kb = record(resolveKnowledgeBase(settings.knowledgeId, loadWorkspaceAppsConfig()) || {})
  if (typeof kb.root !== 'string') throw new Error('Knowledge repository unavailable')
  const knowledge = delivery.knowledge as DeliveryMR
  return !!await mergedByWebhook(kb.root, knowledge, signal, knowledge.iid, record(delivery.knowledgeSnapshot || {}).base as string | undefined)
}

export const deliveryRetryLimit = 6
export const deliveryRetryDelay = (failures: number) => Math.min(15 * 60000, 60000 * 2 ** Math.max(0, failures - 1))

// A poll only requests a worker when new information can advance the workflow.
export async function deliveryNeedsRun(saved: Record<string, unknown>, codeRequest: GitLabRequest, knowledgeRequest: GitLabRequest, signal: AbortSignal) {
  const delivery = record(saved.delivery || {})
  const candidate = delivery.codeCandidate as Omit<DeliveryMR, 'iid' | 'url'> | undefined
  const code = delivery.code as DeliveryMR | undefined
  if (!code) return !!candidate && !!await findDeliveryMR(candidate, signal, codeRequest)
  if (!await mergedMR(code, signal, codeRequest)) return false
  if (!delivery.knowledge) return true
  return mergedMR(delivery.knowledge as DeliveryMR, signal, knowledgeRequest)
}

export async function resetDeliveryRetry(taskId: string) {
  await prisma.cloudAgentDeliveryWatch.updateMany({ where: { taskId }, data: { failures: 0, error: null, nextAttempt: new Date(Date.now() + 60000) } })
}

export async function deferDeliveryRun(claim: NonNullable<Awaited<ReturnType<typeof claimCloudRun>>>, error: unknown, signal: AbortSignal) {
  if (!(error instanceof CloudTransientError) || signal.aborted) return false
  const { task, run } = claim
  const current = await prisma.cloudAgentTask.findFirst({ where: { id: task.id, status: 'delivering', revision: run.revision, materialVersion: run.materialVersion } })
  if (!current || !await prisma.cloudAgentRun.count({ where: { id: run.id, status: 'running', leaseToken: run.leaseToken, leaseUntil: { gt: new Date() } } }) || await prisma.cloudAgentRun.count({ where: { taskId: task.id, status: 'recovery_required' } })) return false
  const watch = await prisma.cloudAgentDeliveryWatch.upsert({ where: { taskId: task.id }, create: { taskId: task.id, failures: 1, error: error.message }, update: { failures: { increment: 1 }, error: error.message } })
  if (watch.failures >= deliveryRetryLimit) return false
  const nextAttempt = new Date(Date.now() + deliveryRetryDelay(watch.failures))
  await prisma.cloudAgentDeliveryWatch.update({ where: { taskId: task.id }, data: { nextAttempt } })
  const saved = record(JSON.parse(current.harnessJson)), delivery = record(saved.delivery || {})
  const status = record(saved.deliveryRequest || {}).action === 'submit_delivery' ? saved.deviceConclusion && record(saved.deviceConclusion).result === 'incomplete' ? 'device_concluded' : 'delivery_ready' : delivery.knowledge ? 'knowledge_review' : 'awaiting_merge'
  await finishCloudRun(run.id, run.leaseToken, status, `交付网络暂时不可用，第 ${watch.failures}/${deliveryRetryLimit} 次；已保留快照，${nextAttempt.toISOString()} 自动重试，不返回代码转译。`)
  return true
}

export async function queueAutomaticDelivery(taskId: string, action: 'submit_delivery' | 'sync_delivery') {
  if (action === 'sync_delivery') {
    const task = await prisma.cloudAgentTask.findUnique({ where: { id: taskId } })
    const handoff = task && (await handoffsFor([task])).get(task.id)
    if (handoff && handoff.status !== 'submitted') return false
  }
  return prisma.$transaction(async tx => {
    const task = await tx.cloudAgentTask.findUnique({ where: { id: taskId } })
    if (!task || !executionConfig(task.appId).delivery?.enabled) return false
    if (!(action === 'submit_delivery' ? ['delivery_ready', 'device_concluded'] : ['awaiting_merge', 'knowledge_review']).includes(task.status)) return false
    if (await tx.cloudAgentRun.count({ where: { taskId, status: { in: ['running', 'recovery_required'] } } })) return false
    const saved = record(JSON.parse(task.harnessJson)), workspace = record(saved.workspace || {})
    if (workspace.materialVersion !== task.materialVersion || !workspace.continuous || record(saved.status || {}).phase !== 'delivery_ready' && !saved.deviceConclusion) return false
    // Automation is created by the local worker, never by model/tool input.
    const updated = await tx.cloudAgentTask.updateMany({ where: { id: taskId, revision: task.revision, status: task.status }, data: {
      status: 'delivery_queued', revision: { increment: 1 }, harnessJson: JSON.stringify({ ...saved, deliveryRequest: { action, automatic: true, actorId: task.creatorId } }),
    } })
    if (!updated.count) return false
    await tx.cloudAgentEvent.create({ data: { taskId, kind: 'delivery-queued', message: action === 'submit_delivery' ? '设备验收结论已生成，自动发布特性分支；开发本地复核确认后才创建集成单' : '开始核验已有 MR 合入状态，合入后按验收结论处理知识回流' } })
    return true
  })
}

export async function scheduleCloudDelivery(signal = new AbortController().signal, needsRun?: typeof deliveryNeedsRun) {
  const deferred = await prisma.cloudAgentDeliveryWatch.findMany({ where: { nextAttempt: { gt: new Date() } }, select: { taskId: true } })
  const tasks = await prisma.cloudAgentTask.findMany({ where: { status: { in: ['delivery_ready', 'device_concluded', 'awaiting_merge', 'knowledge_review'] }, id: { notIn: deferred.map(item => item.taskId) } }, take: 100, orderBy: { updatedAt: 'asc' } })
  const handoffs = await handoffsFor(tasks)
  for (const task of tasks) {
    signal.throwIfAborted()
    if (handoffs.has(task.id) && handoffs.get(task.id) && handoffs.get(task.id)!.status !== 'submitted') continue
    const settings = executionConfig(task.appId).delivery
    if (!settings?.enabled || await prisma.cloudAgentRun.count({ where: { taskId: task.id, status: { in: ['running', 'recovery_required'] } } })) continue
    await prisma.cloudAgentDeliveryWatch.upsert({ where: { taskId: task.id }, create: { taskId: task.id }, update: {} })
    const due = await prisma.cloudAgentDeliveryWatch.updateMany({ where: { taskId: task.id, nextAttempt: { lte: new Date() } }, data: { nextAttempt: new Date(Date.now() + 60000) } })
    if (!due.count) continue
    if (task.status === 'delivery_ready' || task.status === 'device_concluded') { await queueAutomaticDelivery(task.id, 'submit_delivery'); continue }
    try {
      const saved = record(JSON.parse(task.harnessJson))
      const changed = needsRun ? await needsRun(saved, gitlabRequestFor(settings.codeTokenEnv), gitlabRequestFor(settings.knowledgeTokenEnv), signal)
        : settings.transport === 'ssh-webhook' ? await sshDeliveryNeedsRun(task.appId, saved, signal)
        : await deliveryNeedsRun(saved, gitlabRequestFor(settings.codeTokenEnv), gitlabRequestFor(settings.knowledgeTokenEnv), signal)
      if (changed) await queueAutomaticDelivery(task.id, 'sync_delivery')
      else await resetDeliveryRetry(task.id)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof CloudTransientError) {
        const watch = await prisma.cloudAgentDeliveryWatch.update({ where: { taskId: task.id }, data: { failures: { increment: 1 }, error: error.message } })
        await prisma.cloudAgentDeliveryWatch.update({ where: { taskId: task.id }, data: { nextAttempt: new Date(Date.now() + deliveryRetryDelay(watch.failures)) } })
        if (watch.failures < deliveryRetryLimit) continue
      }
      // The normal run publishes actionable errors through the task/notification contract.
      await queueAutomaticDelivery(task.id, 'sync_delivery')
    }
  }
}

// The authenticated inbox only wakes a watcher; the worker independently verifies Git/MR evidence.
export async function wakeDeliveryForMerge(event: Record<string, unknown>) {
  const tasks = await prisma.cloudAgentTask.findMany({ where: { status: { in: ['awaiting_merge', 'knowledge_review'] } } })
  let matched = false
  for (const task of tasks) {
    const delivery = record(record(JSON.parse(task.harnessJson)).delivery || {})
    const candidates = [delivery.code, delivery.codeCandidate, delivery.knowledge].filter(Boolean).map(record)
    if (!candidates.some(mr => mergeEventMatches(event, mr as unknown as DeliveryMR, mr.iid as number | undefined, !!delivery.integrationId && mr.branch !== record(delivery.knowledge || {}).branch))) continue
    await prisma.cloudAgentDeliveryWatch.upsert({ where: { taskId: task.id }, create: { taskId: task.id }, update: {} })
    // Repeated webhooks must not defeat network backoff.
    await prisma.cloudAgentDeliveryWatch.updateMany({ where: { taskId: task.id, failures: 0 }, data: { nextAttempt: new Date() } })
    matched = true
  }
  return matched
}
