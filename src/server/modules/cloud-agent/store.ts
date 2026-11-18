import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { CLOUD_STAGES, cloudStageForStatus, executionLifecycle, type CloudStageId, type CloudStatus, type CloudTask, type CloudSummary, type CloudTaskList, type CloudRun, type CloudRunPage } from '@/contracts/cloud-agent'
import { isTimeRangeId, timeRangeStart } from '@/contracts/time-range'
import { actionsFor, CloudError, parseTaskInput, parseDecision } from './domain'
import { branchAllowed, cloudProject } from './config'
import { requireApp, type CloudActor } from './http'
import { attachMaterials, attachmentDto, savedAttachmentIds, selectMaterialAttachments } from './materials'
import { parseMaterialEdit } from './material-domain'
import type { CloudAttachment } from '@/contracts/cloud-agent'
import { publicReview } from './harness-review'
import { approvedReviews } from './approved-reviews'
import { taskBranchInfo } from './branch-info'
import { verifyHarness, type HarnessWorkspace } from './harness'
import { assertSourceApproval } from './harness-domain'
import { requireChildProcessesStopped } from './process-recovery'
import { stoppedReview } from './review-cycle'
import { inspectCodeReview } from './code-review'
import { taskLifecycles, displayedStage } from './lifecycle'
import { executionConfig } from './execution-config'
import { artifactMaintenanceLock } from './artifact-maintenance'
import { handoffsFor, deliveryDto, handoffDescription } from './delivery-handoff'
import { confirmIntegrationHandoff, deleteIntegrationTask } from '@/server/modules/integration/public'
import { deletionPlan, type TaskDeletionPlan } from './task-deletion'
import { removeTaskWorkspace } from './task-removal'
import type { CloudHandoff } from '@/contracts/cloud-agent'

const include = { runs: { orderBy: { revision: 'desc' as const }, take: 10 }, attachments: true }
const runSelect = { id: true, revision: true, kind: true, status: true, baseSha: true, output: true, digest: true, error: true,
  materialVersion: true, materialSnapshot: true, attachmentSnapshot: true, createdAt: true, finishedAt: true } as const
const recoveryCount = { select: { runs: { where: { status: 'recovery_required' } } } } as const
const detailInclude = { runs: { orderBy: { revision: 'desc' as const }, take: 1, select: runSelect }, attachments: true, _count: recoveryCount }
type TaskRow = Prisma.CloudAgentTaskGetPayload<{ include: typeof detailInclude }>
function runDto(run: Prisma.CloudAgentRunGetPayload<{ select: typeof runSelect }>): CloudRun {
  return { id: run.id, kind: run.kind, status: run.status, baseSha: run.baseSha, output: run.output, digest: run.digest, error: run.error,
    materialVersion: run.materialVersion, materialSnapshot: run.materialSnapshot, attachments: JSON.parse(run.attachmentSnapshot) as CloudAttachment[],
    createdAt: run.createdAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null }
}
function dto(row: TaskRow, handoff?: CloudHandoff): CloudTask {
  const saved = JSON.parse(row.harnessJson)
  if (saved.status?.codeReview) saved.status.codeReview = stoppedReview(saved.status.codeReview, row.runs[0]?.status === 'running' && ['running', 'translating', 'reviewing'].includes(row.status), row.runs[0]?.error || undefined)
  const recoveryRequired = row._count.runs > 0
  const actions = recoveryRequired ? [] : actionsFor(row.status as CloudStatus, row.runs[0]?.kind).filter(action =>
    !(action === 'publish_knowledge' && saved.deviceConclusion?.result === 'incomplete') &&
    (action !== 'rework' || (!saved.delivery?.integrationId && executionConfig(row.appId).delivery?.transport === 'api' && (!!saved.delivery?.code || !!saved.delivery?.priorCode))))
  if (handoff) {
    for (let i = actions.length - 1; i >= 0; i--) if (!['sync_delivery', 'publish_knowledge', 'cancel'].includes(actions[i]) || handoff?.status !== 'submitted' && actions[i] !== 'cancel') actions.splice(i, 1)
  }
  if (!recoveryRequired && row.status === 'awaiting_merge' && handoff?.status === 'pending') actions.push('confirm_delivery')
  return { id: row.id, appId: row.appId, title: row.title, material: row.material, targetBranch: row.targetBranch, model: row.model,
    branch: taskBranchInfo(row.harnessJson), recoveryRequired,
    stage: (row.stage || cloudStageForStatus(row.status as CloudStatus)?.id) as CloudStageId | undefined,
    review: publicReview(saved.review),
    delivery: deliveryDto(saved, handoff), deviceConclusion: saved.deviceConclusion,
    harness: saved.status || null,
    materialVersion: row.materialVersion, attachments: savedAttachmentIds(row.attachmentIds).flatMap(id => row.attachments.filter(file => file.id === id).map(attachmentDto)),
    source: row.source, sourceUrl: row.sourceUrl, status: row.status as CloudStatus, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), actions: saved.workspace?.continuous ? actions : actions.filter(action => !['approve', 'translate', 'resume_translation'].includes(action)),
    runs: row.runs.map(runDto) }
}
async function creatorNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  if (!unique.length) return new Map<string, string>()
  const people = await prisma.apiToken.findMany({ where: { id: { in: unique } }, select: { id: true, personName: true } })
  return new Map(people.map(person => [person.id, person.personName]))
}
export async function listCloudTasks(actor: CloudActor, url: URL): Promise<CloudTaskList> {
  const page = Math.floor(Math.min(10000, Math.max(1, Number(url.searchParams.get('page')) || 1)))
  const q = (url.searchParams.get('q') || '').slice(0, 160)
  const status = (url.searchParams.get('status') || '').slice(0, 40)
  const appId = url.searchParams.get('appId')
  if (appId) requireApp(actor, appId)
  const stageId = url.searchParams.get('stage')
  const stage = stageId ? CLOUD_STAGES.find(item => item.id === stageId) : undefined
  if (stageId && !stage) throw new CloudError('无效阶段')
  const filter = url.searchParams.get('filter') || 'all'
  const filters: Record<string, string[]> = { active: ['queued', 'running', 'review_queued', 'reviewing', 'approved', 'translation_queued', 'translating', 'code_ready', 'delivery_ready', 'device_concluded', 'delivery_queued', 'delivering', 'awaiting_merge', 'knowledge_review'], confirmation: ['awaiting_approval'], issues: ['awaiting_input', 'blocked', 'failed', 'harness_waiting'], completed: ['completed'], cancelled: ['cancelled', 'cancelling'] }
  if (filter !== 'all' && !filters[filter]) throw new CloudError('无效任务筛选')
  const range = url.searchParams.get('range') || 'all'
  if (!isTimeRangeId(range)) throw new CloudError('无效时间范围')
  const since = timeRangeStart(range)
  const base: Prisma.CloudAgentTaskWhereInput = { appId: { in: appId ? [appId] : actor.appIds }, ...(q ? { OR: [{ title: { contains: q } }, { id: q }] } : {}), ...(since ? { updatedAt: { gte: since } } : {}) }
  const legacyRows = await prisma.cloudAgentTask.findMany({ where: { AND: [base, { NOT: { harnessJson: { contains: '"lifecycle":' } } }, { stage: { in: ['coding', 'review', 'build', 'device'] } }] }, select: { id: true, status: true, stage: true, materialVersion: true, harnessJson: true } })
  const lifecycles = await taskLifecycles(legacyRows)
  const corrections = legacyRows.filter(row => displayedStage(row, lifecycles.get(row.id)) !== row.stage)
  let confirmationIds: string[] = []
  if (filter === 'confirmation') {
    const candidates = await prisma.cloudAgentTask.findMany({ where: { AND: [base, { status: 'awaiting_merge' }] }, select: { id: true, harnessJson: true } })
    confirmationIds = [...await handoffsFor(candidates)].filter(([, handoff]) => handoff?.status === 'pending').map(([id]) => id)
  }
  const where: Prisma.CloudAgentTaskWhereInput = { AND: [base, ...(filter === 'confirmation' ? [{ OR: [{ status: 'awaiting_approval' }, { id: { in: confirmationIds } }] }] : filter !== 'all' ? [{ status: { in: filters[filter] } }] : []), ...(status ? [{ status }] : []), ...(stage ? [{ status: { not: 'cancelled' }, OR: [{ id: { in: corrections.filter(row => displayedStage(row, lifecycles.get(row.id)) === stage.id).map(row => row.id) } }, { id: { notIn: corrections.map(row => row.id) }, OR: [{ stage: stage.id }, { stage: '', status: { in: [...stage.statuses] } }] }] }] : [])] }
  const statusCounts = prisma.cloudAgentTask.groupBy({ by: ['status', 'stage'], where: base, _count: { _all: true } })
  const [rows, total, groups] = await prisma.$transaction([
    prisma.cloudAgentTask.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 30, take: 30,
      select: { id: true, appId: true, title: true, targetBranch: true, model: true, source: true, sourceUrl: true, status: true, stage: true, revision: true, materialVersion: true, creatorId: true, createdAt: true, updatedAt: true, harnessJson: true, _count: recoveryCount } }),
    prisma.cloudAgentTask.count({ where }),
    statusCounts,
  ])
  const summary: CloudSummary = { total: 0, byStatus: {}, byStage: {}, issuesByStage: {} }
  for (const item of CLOUD_STAGES) summary.byStage[item.id] = 0
  for (const group of groups) {
    const count = group._count._all, key = group.status as CloudStatus
    summary.total += count; summary.byStatus[key] = (summary.byStatus[key] || 0) + count
    const stage = group.stage || cloudStageForStatus(key)?.id
    if (key !== 'cancelled' && stage && CLOUD_STAGES.some(item => item.id === stage)) {
      const id = stage as CloudStageId
      summary.byStage[id] = (summary.byStage[id] || 0) + count
      if (['failed', 'blocked', 'harness_waiting'].includes(key)) summary.issuesByStage![id] = (summary.issuesByStage![id] || 0) + count
    }
  }
  for (const row of corrections) {
    if (row.status === 'cancelled') continue
    const from = row.stage as CloudStageId, to = displayedStage(row, lifecycles.get(row.id))!
    summary.byStage[from] = (summary.byStage[from] || 0) - 1
    summary.byStage[to] = (summary.byStage[to] || 0) + 1
    if (['failed', 'blocked', 'harness_waiting'].includes(row.status)) {
      summary.issuesByStage![from] = (summary.issuesByStage![from] || 0) - 1
      summary.issuesByStage![to] = (summary.issuesByStage![to] || 0) + 1
    }
  }
  const handoffs = await handoffsFor(rows)
  const names = await creatorNames(rows.map(row => row.creatorId))
  return { items: rows.map(({ harnessJson, _count, creatorId, ...row }) => ({ ...row, creatorName: creatorId ? names.get(creatorId) || null : null, owned: creatorId === actor.id, delivery: deliveryDto(JSON.parse(harnessJson), handoffs.get(row.id)), deviceConclusion: JSON.parse(harnessJson).deviceConclusion, recoveryRequired: _count.runs > 0, branch: taskBranchInfo(harnessJson), stage: displayedStage(row, lifecycles.get(row.id)) || cloudStageForStatus(row.status as CloudStatus)?.id, status: row.status as CloudStatus, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), actions: _count.runs > 0 ? [] : actionsFor(row.status as CloudStatus).filter(action => !(action === 'publish_knowledge' && JSON.parse(harnessJson).deviceConclusion?.result === 'incomplete') && (action !== 'rework' || (!JSON.parse(harnessJson).delivery?.integrationId && executionConfig(row.appId).delivery?.transport === 'api'))), runs: [], material: '', attachments: [] })), total, page, summary }
}
export async function getCloudTask(actor: CloudActor, id: string) {
  const row = await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, include: detailInclude })
  if (!row) throw new CloudError('任务不存在或无权限', 404)
  const lifecycle = (await taskLifecycles([row])).get(row.id)
  const task = dto(row, (await handoffsFor([row])).get(row.id))
  const names = await creatorNames([row.creatorId])
  return { ...task, creatorName: row.creatorId ? names.get(row.creatorId) || null : null, owned: row.creatorId === actor.id, stage: displayedStage(row, lifecycle) || task.stage, harness: task.harness && lifecycle ? { ...task.harness, lifecycle } : task.harness, approvedReviews: (await approvedReviews(row)).map(review => publicReview(review)!) }
}
export async function deleteCloudTask(actor: CloudActor, id: string, remove: (plan: TaskDeletionPlan, harmonyRoot: string) => Promise<void> = removeTaskWorkspace) {
  const row = await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, include: { attachments: { select: { id: true } }, runs: { where: { status: 'running' }, select: { id: true }, take: 1 } } })
  if (!row) throw new CloudError('任务不存在或无权限', 404)
  const plan = deletionPlan(row, actor.id, row.creatorId, row.status, row.runs.length > 0)
  if (plan.integrationId) {
    try { await deleteIntegrationTask(plan.integrationId) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.startsWith('TASK_DELETE_BLOCKED')) throw new CloudError('关联的提测单仍在执行，请等它结束后再删除任务', 409)
      if (!message.startsWith('TASK_NOT_FOUND')) throw error
    }
  }
  await remove(plan, plan.branch || plan.harmonyRoots.length ? cloudProject(row.appId).harmonyRoot : '')
  await prisma.$transaction(async tx => {
    const current = await tx.cloudAgentTask.findFirst({ where: { id, creatorId: actor.id }, select: { status: true } })
    if (!current) throw new CloudError('任务不存在或无权限', 404)
    if (['queued', 'running', 'cancelling', 'translation_queued', 'translating', 'review_queued', 'reviewing', 'delivery_queued', 'delivering'].includes(current.status) || await tx.cloudAgentRun.count({ where: { taskId: id, status: 'running' } })) throw new CloudError('任务仍在执行，请先取消后再删除', 409)
    await tx.cloudAgentEvent.deleteMany({ where: { taskId: id } })
    await tx.cloudAgentApproval.deleteMany({ where: { taskId: id } })
    await tx.cloudAgentRun.deleteMany({ where: { taskId: id } })
    await tx.cloudAgentAttachment.deleteMany({ where: { OR: [{ taskId: id }, { id: { in: plan.attachmentIds } }] } })
    await tx.cloudAgentNotification.deleteMany({ where: { taskId: id } })
    await tx.cloudAgentDeliveryWatch.deleteMany({ where: { taskId: id } })
    await tx.cloudAgentTask.delete({ where: { id } })
  })
}
export async function listCloudRuns(actor: CloudActor, id: string, url: URL): Promise<CloudRunPage> {
  const raw = url.searchParams.get('before')
  const before = raw === null ? undefined : Number(raw)
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new CloudError('历史游标无效')
  if (!await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, select: { id: true } })) throw new CloudError('任务不存在或无权限', 404)
  const rows = await prisma.cloudAgentRun.findMany({ where: { taskId: id, ...(before ? { revision: { lt: before } } : {}) }, orderBy: { revision: 'desc' }, take: 11, select: runSelect })
  return { items: rows.slice(0, 10).map(runDto), nextBefore: rows.length > 10 ? rows[9].revision : null }
}
export async function createCloudTask(actor: CloudActor, raw: unknown) {
  const input = parseTaskInput(raw)
  requireApp(actor, input.appId)
  const project = cloudProject(input.appId)
  if (!branchAllowed(project, input.targetBranch)) throw new CloudError('此 App 不允许使用该分支', 403)
  const row = await prisma.$transaction(async tx => {
    const outstanding = await tx.cloudAgentTask.count({ where: { creatorId: actor.id, status: { in: ['queued', 'running', 'cancelling', 'awaiting_input', 'awaiting_approval'] } } })
    if (outstanding >= 10) throw new CloudError('待处理任务已达 10 个，请先处理已有任务', 429)
    const queued = await tx.cloudAgentTask.count({ where: { status: 'queued' } })
    if (queued >= 100) throw new CloudError('分析队列已满，请稍后再试', 429)
    await selectMaterialAttachments(tx, actor, input.appId, input.attachmentIds)
    const created = await tx.cloudAgentTask.create({ data: { ...input, attachmentIds: JSON.stringify(input.attachmentIds), creatorId: actor.id, model: project.model,
      events: { create: { kind: 'created', message: '需求已创建，等待自动分析' } } }, include })
    await attachMaterials(tx, created.id, input.attachmentIds)
    return created
  })
  return getCloudTask(actor, row.id)
}
export async function saveCloudMaterials(actor: CloudActor, id: string, raw: unknown) {
  const input = parseMaterialEdit(raw)
  await prisma.$transaction(async tx => {
    const task = await tx.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } } })
    if (!task) throw new CloudError('任务不存在或无权限', 404)
    if (task.materialVersion !== input.materialVersion) throw new CloudError('材料已被其他人更新，请关闭编辑器并重新打开后合并修改', 409)
    if (input.reanalyze) {
      if (['cancelled', 'completed'].includes(task.status)) throw new CloudError('任务已结束，请新建变更任务', 409)
      if (['running', 'translating', 'reviewing', 'delivering', 'cancelling'].includes(task.status)) throw new CloudError('当前任务仍在运行，请先暂存草稿，本轮结束后再提交修改', 409)
      if (await tx.cloudAgentRun.count({ where: { taskId: id, status: { in: ['running', 'recovery_required'] } } })) throw new CloudError('旧实例尚未确认停止，不能启动新分析', 409)
      if (await tx.cloudAgentTask.count({ where: { status: { in: ['queued', 'translation_queued'] } } }) >= 100) throw new CloudError('执行队列已满，请稍后再试', 429)
    }
    if (JSON.parse(task.harnessJson).delivery?.codeSnapshot || JSON.parse(task.harnessJson).delivery?.priorCode || ['delivery_queued', 'delivering', 'completed'].includes(task.status)) throw new CloudError('任务已进入交付，请新建变更任务，不能修改已固定快照的材料', 409)
    await selectMaterialAttachments(tx, actor, task.appId, input.attachmentIds, id)
    const ids = JSON.stringify(input.attachmentIds)
    if (task.material === input.material && task.attachmentIds === ids) {
      if (input.reanalyze) throw new CloudError('材料未变化，可直接继续分析或审核', 409)
      return
    }
    const updated = await tx.cloudAgentTask.updateMany({ where: { id, materialVersion: input.materialVersion, status: task.status }, data: {
      material: input.material, attachmentIds: ids, materialVersion: { increment: 1 },
      ...(['approved', 'awaiting_approval', 'harness_waiting', 'code_ready', 'translation_queued', 'review_queued'].includes(task.status) ? { status: 'awaiting_input' } : {}),
      ...(input.reanalyze ? { status: 'queued', stage: 'analysis', revision: { increment: 1 } } : {}),
    } })
    if (updated.count !== 1) throw new CloudError('任务已变化，请刷新后保存材料', 409)
    await attachMaterials(tx, id, input.attachmentIds)
    await tx.cloudAgentEvent.create({ data: { taskId: id, kind: 'materials', message: `已保存材料 v${input.materialVersion + 1}（${input.attachmentIds.length} 个附件）；${input.reanalyze ? '已排队重新分析，旧批准不适用于新材料' : '未启动新的分析'}` } })
  })
  return getCloudTask(actor, id)
}
export async function decideCloudTask(actor: CloudActor, id: string, raw: unknown) {
  const decision = parseDecision(raw)
  if (decision.action === 'confirm_delivery') {
    let attemptedSnapshot: string | undefined
    try { await prisma.$transaction(async tx => {
      const task = await tx.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } } })
      if (!task) throw new CloudError('任务不存在或无权限', 404)
      if (task.revision !== decision.revision || task.status !== 'awaiting_merge') throw new CloudError('任务已变化，请刷新后操作', 409)
      if (await tx.cloudAgentRun.count({ where: { taskId: id, status: { in: ['running', 'recovery_required'] } } })) throw new CloudError('任务执行尚未结算，不能确认提测', 409)
      const saved = JSON.parse(task.harnessJson), delivery = saved.delivery, candidate = delivery?.codeCandidate || delivery?.code
      if (!candidate || !delivery.codeSnapshot?.sha || candidate.sha !== delivery.codeSnapshot.sha || candidate.target !== task.targetBranch || !saved.workspace?.identity) throw new CloudError('特性分支尚未发布或交付信息不一致', 409)
      const integrationId = delivery.integrationId || `cloud-${id}`
      let changed: boolean
      attemptedSnapshot = task.harnessJson
      try { changed = await confirmIntegrationHandoff(tx, { id: integrationId, projectId: `app-${task.appId.toLowerCase()}`, branch: candidate.branch, target: task.targetBranch, sha: delivery.codeSnapshot.sha, actorId: actor.id,
        ...(!delivery.integrationId ? { create: { title: task.title, createdByTokenId: task.creatorId || actor.id, featureDesc: handoffDescription({ taskId: id, identity: saved.workspace.identity, sha: delivery.codeSnapshot.sha, documents: `${saved.workspace.documentsPath || 'docs/migrations'}/${task.appId}/${saved.workspace.identity}`, deviceConclusion: saved.deviceConclusion }) } } : {}) }) }
      catch (error) { throw new CloudError((error as Error).message, 409) }
      if (!changed && delivery.integrationId) return
      await tx.cloudAgentTask.update({ where: { id }, data: { updatedAt: new Date(), harnessJson: JSON.stringify({ ...saved, delivery: { ...delivery, integrationId, confirmationError: undefined } }) } })
      await tx.cloudAgentEvent.create({ data: { taskId: id, kind: 'confirm_delivery', message: `开发已完成本地复核并确认提测，已${delivery.integrationId ? '复用' : '创建'}集成单：${integrationId}；后续修复在本地完成，工作台不重跑转译。${decision.reason ? `\n备注：${decision.reason}` : ''}` } })
      await tx.cloudAgentDeliveryWatch.updateMany({ where: { taskId: id }, data: { failures: 0, error: null, nextAttempt: new Date() } })
    }) } catch (error) {
      if (attemptedSnapshot) {
        const saved = JSON.parse(attemptedSnapshot)
        await prisma.cloudAgentTask.updateMany({ where: { id, revision: decision.revision, status: 'awaiting_merge', harnessJson: attemptedSnapshot }, data: {
          harnessJson: JSON.stringify({ ...saved, delivery: { ...saved.delivery, confirmationError: '确认提测未成功，请核对集成记录后重试；分支和验收记录已保留。' } }),
        } }).catch(() => {})
      }
      throw error
    }
    return getCloudTask(actor, id)
  }
  let refreshed: { before: string; after: string } | undefined
  if (decision.action === 'resume_translation') {
    const task = await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, include })
    if (!task) throw new CloudError('任务不存在或无权限', 404)
    if (await prisma.cloudAgentRun.count({ where: { taskId: id, status: 'recovery_required' } })) throw new CloudError('执行中断，需先由运维恢复：核验旧进程和 Harness 未完成记录后才能继续；无需重新审批需求，刷新不能解除恢复锁', 409)
    if (JSON.parse(task.harnessJson).delivery?.codeCandidate && !['sync_delivery', 'publish_knowledge', 'cancel'].includes(decision.action)) throw new CloudError('已交接开发，问题请在本地修复和验收，工作台不再重跑转译', 409)
    if (task.revision !== decision.revision || !actionsFor(task.status as CloudStatus, task.runs[0]?.kind).includes(decision.action)) throw new CloudError('任务已变化，请刷新后操作', 409)
    if (await prisma.cloudAgentRun.count({ where: { taskId: id, status: 'running' } })) throw new CloudError('任务仍在执行，不能重复启动', 409)
    const saved = JSON.parse(task.harnessJson), workspace = saved.workspace as HarnessWorkspace | undefined
    if (saved.worktreeRelocation && saved.worktreeRelocation.status !== 'completed') throw new CloudError('工作树迁移未完成，请运维继续原迁移操作', 409)
    if (!workspace?.continuous || workspace.materialVersion !== task.materialVersion) throw new CloudError('材料已变化，不能沿用旧批准', 409)
    if (['artifactRoot', 'runDir', 'androidRoot', 'harmonyRoot'].some(key => typeof workspace[key as keyof HarnessWorkspace] !== 'string' || !workspace[key as keyof HarnessWorkspace])) throw new CloudError('任务缺少原生档案路径，不能依据缓存继续转译', 409)
    await requireChildProcessesStopped(workspace.artifactRoot)
    const checked = await verifyHarness(workspace, AbortSignal.timeout(120000), 'ui_prototype_approved')
    assertSourceApproval(checked.raw)
    if (checked.status.nodes.some(node => node.id === 'wired' && node.status === 'passed')) checked.status.codeReview = await inspectCodeReview(workspace, AbortSignal.timeout(120000))
    checked.status.lifecycle = executionLifecycle(checked.status, task.materialVersion, (await taskLifecycles([task])).get(task.id), task.stage)
    refreshed = { before: task.harnessJson, after: JSON.stringify({ ...saved, status: checked.status }) }
  }
  await prisma.$transaction(async tx => {
    const task = await tx.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, include })
    if (!task) throw new CloudError('任务不存在或无权限', 404)
    if (refreshed && task.harnessJson !== refreshed.before) throw new CloudError('任务档案已变化，请重新校验', 409)
    if (task.revision !== decision.revision || !actionsFor(task.status as CloudStatus, task.runs[0]?.kind).includes(decision.action)) throw new CloudError('任务已变化，请刷新后操作', 409)
    if (await tx.cloudAgentRun.count({ where: { taskId: id, status: 'recovery_required' } })) throw new CloudError('执行中断，需先由运维恢复：核验旧进程和 Harness 未完成记录后才能继续；无需重新审批需求，刷新不能解除恢复锁', 409)
    const relocation = JSON.parse(task.harnessJson).worktreeRelocation
    if (relocation && relocation.status !== 'completed') throw new CloudError('工作树迁移未完成，请运维继续原迁移操作', 409)
    const run = task.runs[0]
    if (JSON.parse(task.harnessJson).delivery?.codeCandidate && !['sync_delivery', 'publish_knowledge', 'cancel'].includes(decision.action)) throw new CloudError('已交接开发，问题请在本地修复和验收，工作台不再重跑转译', 409)
    if (JSON.parse(task.harnessJson).delivery?.codeSnapshot && !['submit_delivery', 'sync_delivery', 'publish_knowledge', 'rework', 'cancel'].includes(decision.action)) throw new CloudError('交付快照已固定，请先发起返修', 409)
    let status: CloudStatus
    if (decision.action === 'approve') {
      const saved = JSON.parse(task.harnessJson)
      const review = saved.review
      if (!saved.workspace?.continuous || !review || review.digest !== decision.digest || review.materialVersion !== task.materialVersion || !run || run.materialVersion !== task.materialVersion || run.status !== 'awaiting_approval') throw new CloudError('审批产物已失效或属于旧流程，请继续分析生成 Harness 审核包', 409)
      if (review.kind === 'visual' && review.decision === 'accepted_with_differences' && !decision.reason?.trim()) throw new CloudError('接受视觉差异需填写具体差异和理由', 400)
      const reason = decision.reason || (review.kind === 'scope' ? '确认当前需求范围与验收标准，继续准备 UI 基线' : review.kind === 'ui' ? '确认当前 UI 基线，校验通过后开始代码转译' : '确认当前真机视觉效果，继续验收')
      await tx.cloudAgentApproval.create({ data: { taskId: id, revision: task.revision, actorId: actor.id, digest: review.digest, decision: review.kind, reason, payload: JSON.stringify(review) } })
      status = 'review_queued'
    } else if (['submit_delivery', 'sync_delivery', 'publish_knowledge', 'rework'].includes(decision.action)) {
      const saved = JSON.parse(task.harnessJson)
      if (!saved.workspace?.continuous || saved.workspace.materialVersion !== task.materialVersion ||
        (decision.action === 'submit_delivery' && !['delivery_ready', 'device_concluded'].includes(task.status) && !saved.delivery?.codeSnapshot) ||
        (saved.status?.phase !== 'delivery_ready' && !saved.deviceConclusion)) throw new CloudError('Harness 尚未交付就绪且设备结论未生成，不能提测或回流', 409)
      if (decision.action === 'publish_knowledge' && saved.deviceConclusion?.result === 'incomplete') throw new CloudError('设备验收未完成，没有严格交付文档可回流', 409)
      if (decision.action === 'publish_knowledge' && !saved.delivery?.codeMerged) throw new CloudError('代码 MR 尚未核实合入', 409)
      const resumingRework = task.status === 'failed' && saved.deliveryRequest?.action === 'rework' && saved.delivery?.priorCode && saved.delivery?.reworkReason && !saved.delivery?.codeSnapshot
      if (decision.action === 'rework' && ((!saved.delivery?.code && !resumingRework) || saved.delivery?.codeMerged || saved.delivery?.knowledge)) throw new CloudError('仅未合入的代码 MR 可以返修', 409)
      if (decision.action === 'rework' && executionConfig(task.appId).delivery?.transport !== 'api') throw new CloudError('无 Token 模式不能核实已有 MR 仍开放，请新建变更任务重新验收', 409)
      status = 'delivery_queued'
    } else if (decision.action === 'translate' || decision.action === 'resume_translation') {
      const saved = JSON.parse(refreshed?.after || task.harnessJson)
      if (!saved.workspace?.continuous || saved.workspace.materialVersion !== task.materialVersion || !saved.status?.nodes?.some((node: { id: string; status: string }) => node.id === 'ui_prototype_approved' && node.status === 'passed')) throw new CloudError('当前材料缺少真实 Scope/UI 审批，请继续分析并审批', 409)
      if (await tx.cloudAgentTask.count({ where: { status: { in: ['queued', 'translation_queued'] } } }) >= 100) throw new CloudError('执行队列已满，请稍后再试', 429)
      status = 'translation_queued'
    } else if (decision.action === 'cancel') status = ['running', 'translating', 'reviewing', 'delivering'].includes(task.status) ? 'cancelling' : 'cancelled'
    else {
      if (task.status === 'blocked' && task.runs.some(item => item.status === 'recovery_required')) throw new CloudError('旧实例状态未确认，需先由运维恢复', 409)
      status = 'queued'
    }
    const updated = await tx.cloudAgentTask.updateMany({ where: { id, revision: task.revision, status: task.status }, data: {
      status, ...(['queued', 'translation_queued', 'review_queued', 'delivery_queued'].includes(status) ? { revision: { increment: 1 } } : {}),
      ...(status === 'delivery_queued' ? { harnessJson: JSON.stringify({ ...JSON.parse(task.harnessJson), deliveryRequest: { action: decision.action, actorId: actor.id, reason: decision.reason } }) } : {}),
      ...(status === 'review_queued' ? { harnessJson: JSON.stringify({ ...JSON.parse(task.harnessJson), reviewCommitted: true }) } : {}),
      ...(status === 'translation_queued' && refreshed ? { harnessJson: refreshed.after } : {}),
      ...(status === 'review_queued' ? { stage: JSON.parse(task.harnessJson).review?.kind === 'visual' ? 'device' : 'approval' } : status === 'translation_queued' ? { stage: executionLifecycle(JSON.parse(refreshed?.after || task.harnessJson).status, task.materialVersion, JSON.parse(refreshed?.after || task.harnessJson).status?.lifecycle, task.stage).stage } : {}),
    } })
    if (updated.count !== 1) throw new CloudError('并发操作冲突', 409)
    if (status === 'delivery_queued') await tx.cloudAgentDeliveryWatch.updateMany({ where: { taskId: id }, data: { failures: 0, error: null, nextAttempt: new Date() } })
    await tx.cloudAgentEvent.create({ data: { taskId: id, runId: run?.id, kind: decision.action,
      message: decision.action === 'approve' ? '已保存人工决定，等待 Harness 原生登记与校验' : decision.action === 'cancel' ? '已请求取消任务' : status === 'delivery_queued' ? '交付操作已排队，执行前将核验 Harness 证据与操作者权限' : status === 'translation_queued' ? '沿用当前分支和已审档案，从未完成环节继续；不重新开始编码，不自动提交或推送' : '沿用档案继续分析；材料修订将重新核验审批有效性' } })
  })
  return getCloudTask(actor, id)
}
export async function cloudEvents(actor: CloudActor, id: string, after: number) {
  if (!await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } }, select: { id: true } })) throw new CloudError('任务不存在或无权限', 404)
  return (await prisma.cloudAgentEvent.findMany({ where: { taskId: id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 200 })).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))
}
export async function claimCloudRun() {
  const candidates = await prisma.cloudAgentTask.findMany({ where: { status: { in: ['queued', 'translation_queued', 'review_queued', 'delivery_queued'] } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true } })
  for (const candidate of candidates) {
    let release: (() => Promise<void>) | undefined
    try { release = await artifactMaintenanceLock(candidate.id, 'worker:claim', new AbortController().signal) }
    catch (error) { if (error instanceof CloudError && error.status === 409) continue; throw error }
    try {
    const claimed = await prisma.$transaction(async tx => {
    const task = await tx.cloudAgentTask.findFirst({ where: { id: candidate.id, status: { in: ['queued', 'translation_queued', 'review_queued', 'delivery_queued'] } }, include: { attachments: true } })
    if (!task) return null
    const kind = task.status === 'delivery_queued' ? 'delivery' : task.status === 'translation_queued' ? 'translation' : task.status === 'review_queued' ? 'review' : 'analysis'
    const update = await tx.cloudAgentTask.updateMany({ where: { id: task.id, status: task.status, revision: task.revision }, data: { status: kind === 'delivery' ? 'delivering' : kind === 'translation' ? 'translating' : kind === 'review' ? 'reviewing' : 'running' } })
    if (update.count !== 1) return null
    const attachments = savedAttachmentIds(task.attachmentIds).map(id => {
      const file = task.attachments.find(item => item.id === id)
      if (!file || file.status !== 'ready') throw new CloudError('任务附件缺失', 503)
      return attachmentDto(file)
    })
    const run = await tx.cloudAgentRun.create({ data: { taskId: task.id, revision: task.revision, kind, harnessJson: task.harnessJson, input: task.material, materialSnapshot: task.material, materialVersion: task.materialVersion,
      attachmentSnapshot: JSON.stringify(attachments), leaseToken: randomBytes(24).toString('hex'), leaseUntil: new Date(Date.now() + 90_000) } })
    await tx.cloudAgentEvent.create({ data: { taskId: task.id, runId: run.id, kind: 'running', message: kind === 'delivery' ? '开始交付核验与知识回流；保留已完成的转译和验收' : kind === 'translation' ? '开始准备独立 Worktree 与 Harness 执行' : '开始核验分支、收集材料并分析' } })
    return { task, run }
    })
    if (claimed) return claimed
    } finally { await release() }
  }
  return null
}
export async function appendCloudEvent(taskId: string, runId: string, kind: string, message: string) {
  for (let offset = 0; offset < message.length; offset += 12000) await prisma.cloudAgentEvent.create({ data: { taskId, runId, kind, message: message.slice(offset, offset + 12000) } })
}
export async function finishCloudRun(runId: string, leaseToken: string, status: 'awaiting_input' | 'awaiting_approval' | 'approved' | 'translation_queued' | 'blocked' | 'failed' | 'recovery_required' | 'harness_waiting' | 'code_ready' | 'delivery_ready' | 'device_concluded' | 'awaiting_merge' | 'knowledge_review' | 'completed', output: string, error?: string) {
  return prisma.$transaction(async tx => {
    const run = await tx.cloudAgentRun.findUnique({ where: { id: runId } })
    if (!run || run.leaseToken !== leaseToken || run.status !== 'running' || run.leaseUntil <= new Date()) return
    const task = await tx.cloudAgentTask.findUniqueOrThrow({ where: { id: run.taskId } })
    const stale = task.materialVersion !== run.materialVersion
    const finalStatus = status === 'recovery_required' ? run.kind === 'translation' ? 'harness_waiting' : 'blocked' : task.status === 'cancelling' ? 'cancelled' : stale ? 'awaiting_input' : run.kind === 'translation' && status === 'failed' ? 'harness_waiting' : status
    if (!['running', 'translating', 'reviewing', 'delivering', 'cancelling'].includes(task.status) || task.revision !== run.revision) return
    if (finalStatus === 'translation_queued') {
      const approval = await tx.cloudAgentApproval.findUnique({ where: { taskId_revision: { taskId: task.id, revision: run.revision - 1 } } })
      const saved = JSON.parse(task.harnessJson)
      if (run.kind !== 'review' || approval?.decision !== 'ui' || saved.workspace?.materialVersion !== task.materialVersion || !['scope_approved', 'ui_prototype_approved'].every(id => saved.status?.nodes?.some((node: { id: string; status: string }) => node.id === id && node.status === 'passed'))) throw new CloudError('UI 人工审批和原生收据未就绪，不能自动转译', 409)
    }
    const digest = output ? createHash('sha256').update(JSON.stringify({ output, input: run.input, baseSha: run.baseSha, model: task.model, revision: run.revision, materialVersion: run.materialVersion, attachments: run.attachmentSnapshot })).digest('hex') : null
    const savedFinal = JSON.parse(task.harnessJson)
    if (savedFinal.status?.codeReview) savedFinal.status.codeReview = stoppedReview(savedFinal.status.codeReview, false, error)
    await tx.cloudAgentRun.update({ where: { id: runId }, data: { status: status === 'recovery_required' ? status : finalStatus === 'translation_queued' ? 'approved' : finalStatus, output, digest, error, finishedAt: new Date() } })
    await tx.cloudAgentTask.update({ where: { id: task.id }, data: { status: finalStatus, harnessJson: JSON.stringify(savedFinal), ...(finalStatus === 'approved' ? { stage: 'ready' } : finalStatus === 'awaiting_approval' ? { stage: JSON.parse(task.harnessJson).review?.kind === 'visual' ? 'device' : 'approval' } : ['knowledge_review', 'completed'].includes(finalStatus) ? { stage: 'knowledge' } : ['delivery_ready', 'device_concluded', 'awaiting_merge'].includes(finalStatus) ? { stage: 'integration' } : {}) } })
    if (finalStatus === 'translation_queued') await tx.cloudAgentTask.update({ where: { id: task.id }, data: { revision: { increment: 1 }, stage: 'coding' } })
    const messages: Record<string, string> = { awaiting_approval: 'Harness 审核包已就绪，等待人工审批', approved: 'Scope/UI 门禁通过，等待发起代码转译', awaiting_input: '已保留当前档案，需要补充证据或继续分析', cancelled: '执行已停止', blocked: '运行已阻塞', failed: '运行失败', harness_waiting: error ? `执行暂停：${error}` : '本轮执行结束但流程未完成；查看执行记录后可继续 Harness，不是新增人工审批', code_ready: '代码待验证', delivery_ready: 'Harness 交付就绪，等待自动登记集成台', device_concluded: '设备验收已出结论，未通过项随提测交接，不代表 Harness 严格交付通过', awaiting_merge: '特性分支已发布，等待开发本地复核并确认提测', knowledge_review: '知识回流 MR 已创建，等待审核合入', completed: '代码合入流程已结束；设备结论和知识回流状态以任务详情为准' }
    await tx.cloudAgentEvent.create({ data: { taskId: task.id, runId, kind: finalStatus, message: error || (finalStatus === 'translation_queued' ? 'UI 基线已批准并通过原生校验，自动排队代码转译；不提交或推送' : stale && finalStatus === 'awaiting_input' ? '本轮执行期间材料已更新，请使用最新材料继续分析后再审批' : messages[finalStatus]) } })
  })
}
