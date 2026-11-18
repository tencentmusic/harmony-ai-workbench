import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import { resolveKnowledgeBase, loadWorkspaceAppsConfig } from '@/lib/workspace-apps-config'
import { handoffsFor } from './delivery-handoff'
import { cloudProject } from './config'
import { executionConfig } from './execution-config'
import { CloudError, record } from './domain'
import { tokenCanAccessCloudApp } from './access'
import { repositoryIdentity, freezeBranch, git } from './git'
import { taskWorktree } from './worktrees'
import { scopedPath, sha256 } from './scoped-files'
import { verifyHarness, type HarnessWorkspace } from './harness'
import { finishCloudRun, type claimCloudRun } from './store'
import { snapshotCommit, pushSnapshot, ensureMR, findDeliveryMR, mergedMR, requireOpenMR, type DeliveryMR } from './delivery-git'
import { inspectCodeReview, requireCodeReview } from './code-review'
import { bundleKnowledgeDocuments } from './knowledge-bundle'
import { prepareBranchDocuments, prepareDeviceConclusionDocuments } from './branch-documents'
import { assertDeviceConclusion, canConcludeDevice } from './device-conclusion'
import type { CloudDeviceConclusion } from '@/contracts/cloud-agent'
import { gitlabRequestFor } from './gitlab-access'
import { mergedByWebhook, pushKnowledgeMR } from './delivery-ssh'
import { prepareFeatureKnowledge } from './knowledge-ingest'
import { assertHarmonyHead } from './harmony-head'

interface Snapshot { sha: string; tree: string; base: string; codeTree?: string }
interface DeliveryState { code?: DeliveryMR; codeCandidate?: Omit<DeliveryMR, 'iid' | 'url'>; codeSnapshot?: Snapshot; codeMerged?: boolean; knowledge?: DeliveryMR; knowledgeSnapshot?: Snapshot; knowledgeWorktree?: { root: string; branch: string; base: string }; integrationId?: string; configDigest?: string; priorCode?: DeliveryMR; reworkReason?: string; history?: { code: DeliveryMR; snapshot: Snapshot; reason: string; createdAt: string }[] }
const deliveryAdapters = { cloudProject, executionConfig, repositoryIdentity, requireCodeReview, inspectCodeReview, verifyHarness, prepareBranchDocuments, prepareDeviceConclusionDocuments, resolveKnowledgeBase, freezeBranch, taskWorktree, prepareFeatureKnowledge, mergedByWebhook, pushKnowledgeMR }
export async function runDelivery(claim: NonNullable<Awaited<ReturnType<typeof claimCloudRun>>>, signal: AbortSignal, checkLease: () => Promise<void>, adapters: Partial<typeof deliveryAdapters> = {}) {
  const { cloudProject, executionConfig, repositoryIdentity, requireCodeReview, inspectCodeReview, verifyHarness, prepareBranchDocuments, prepareDeviceConclusionDocuments, resolveKnowledgeBase, freezeBranch, taskWorktree, prepareFeatureKnowledge, mergedByWebhook, pushKnowledgeMR } = { ...deliveryAdapters, ...adapters }
  const { task, run } = claim, saved = record(JSON.parse(task.harnessJson)), request = record(saved.deliveryRequest)
  const workspace = saved.workspace as HarnessWorkspace, state = (saved.delivery || {}) as DeliveryState
  const conclusion = saved.deviceConclusion as CloudDeviceConclusion | undefined
  const provisional = conclusion?.result === 'incomplete'
  const project = cloudProject(task.appId), settings = executionConfig(task.appId).delivery
  if (!settings?.enabled || !workspace?.continuous || workspace.materialVersion !== task.materialVersion) throw new CloudError('交付配置未启用或材料已变化', 409)
  if ((workspace.documentsPath || 'docs/migrations') !== project.documentsPath) throw new CloudError('文档归档目录已变化，请恢复任务原配置', 409)
  const source = await repositoryIdentity(project.harmonyRoot)
  const { codeTokenEnv, knowledgeTokenEnv, ...targetSettings } = settings
  const codeRequest = gitlabRequestFor(codeTokenEnv), knowledgeRequest = gitlabRequestFor(knowledgeTokenEnv)
  const configDigest = sha256(JSON.stringify({ settings: targetSettings, source: { origin: source.origin, repository: source.repository }, app: task.appId, branch: task.targetBranch }))
  if (state.configDigest && state.configDigest !== configDigest) throw new CloudError('交付目标配置已变化，需人工核验', 409)
  state.configDigest = configDigest
  const actorId = typeof request.actorId === 'string' ? request.actorId : null
  async function guard() {
    await checkLease(); signal.throwIfAborted()
    if (actorId) {
      if (!await tokenCanAccessCloudApp(actorId, task.appId)) throw new CloudError('交付操作者权限已失效', 403)
    } else if (request.automatic !== true || task.creatorId || task.source !== 'android-mr' || !task.originKey || !project.mrTrigger) throw new CloudError('自动交付缺少可信来源或操作者', 403)
  }
  async function save(message: string) {
    await guard()
    await prisma.$transaction(async tx => {
      const updated = await tx.cloudAgentTask.updateMany({ where: { id: task.id, status: 'delivering', revision: run.revision, materialVersion: run.materialVersion }, data: { harnessJson: JSON.stringify({ ...saved, delivery: state }), stage: request.action === 'rework' ? 'coding' : state.knowledge ? 'knowledge' : 'integration' } })
      if (!updated.count) throw new CloudError('交付任务已停止', 409)
      await tx.cloudAgentEvent.create({ data: { taskId: task.id, runId: run.id, kind: 'delivery', message } })
    })
  }
  await guard()
  if (request.action === 'rework') {
    if (state.integrationId) throw new CloudError('已交接开发，本地修复和验收不再重跑转译', 409)
    if (settings.transport === 'ssh-webhook') throw new CloudError('无 Token 模式不自动更新已有 MR；请通过新变更任务重新验收', 409)
    if (saved.status) delete (saved.status as { lifecycle?: unknown }).lifecycle
    delete saved.deviceConclusion
    // A prior attempt may have persisted the reset before finishCloudRun failed.
    if (!state.code && state.priorCode && state.reworkReason && !state.codeSnapshot && !state.knowledge) {
      await requireOpenMR(state.priorCode, signal, codeRequest)
      await finishCloudRun(run.id, run.leaseToken, 'harness_waiting', `继续已登记返修：${state.reworkReason}`)
      return
    }
    if (!state.code || !state.codeSnapshot || state.knowledge || typeof request.reason !== 'string' || !request.reason.trim()) throw new CloudError('返修缺少未合入 MR、快照或原因', 409)
    await requireOpenMR(state.code, signal, codeRequest)
    state.history = [...(state.history || []), { code: state.code, snapshot: state.codeSnapshot, reason: request.reason, createdAt: new Date().toISOString() }]
    state.priorCode = state.code
    state.reworkReason = request.reason
    state.code = undefined
    state.codeCandidate = undefined
    state.codeSnapshot = undefined
    state.codeMerged = false
    saved.status = { ...record(saved.status), codeReview: { status: 'failed', summary: '人工返修，等待重新审查', checks: [], findings: [] } }
    await mkdir(path.join(workspace.artifactRoot, 'code-review'), { recursive: true })
    await writeFile(path.join(workspace.artifactRoot, 'code-review/current.json'), JSON.stringify({ status: 'failed', summary: '人工发起返修，必须重新审查并验收' }))
    await save('已保留原 MR 和验收快照，进入返修；禁止沿用旧审查结论')
    await finishCloudRun(run.id, run.leaseToken, 'harness_waiting', `返修要求：${request.reason}`)
    return
  }
  if (request.action === 'submit_delivery') {
    await assertHarmonyHead(workspace, signal)
    await requireCodeReview(workspace, signal)
    const checked = await verifyHarness(workspace, signal, provisional ? 'initialized' : 'delivery_ready')
    if (provisional) {
      const currentStatus = { ...checked.status, codeReview: await inspectCodeReview(workspace, signal) }
      if (!canConcludeDevice(currentStatus)) throw new CloudError('代码审查或构建已失效，不能发布设备结论', 409)
      await assertDeviceConclusion(workspace, conclusion!, currentStatus)
    } else if (checked.raw.verified !== true) throw new CloudError('当前 Harness 交付证据已失效，不能提测', 409)
    const documents = provisional ? await prepareDeviceConclusionDocuments(workspace, conclusion!) : await prepareBranchDocuments(workspace)
    if (!state.codeSnapshot) {
      state.codeSnapshot = await snapshotCommit(workspace.harmonyRoot, workspace.baseSha, [''], workspace.artifactRoot, `feat(${task.appId}): ${task.title}`, signal, state.priorCode?.sha || workspace.baseSha, documents, workspace.harmonyHeadSha)
      const priorSnapshot = state.history?.at(-1)?.snapshot
      if (state.priorCode && state.codeSnapshot.codeTree === (priorSnapshot?.codeTree || priorSnapshot?.tree)) throw new CloudError('返修未产生源码变化，不能仅更新文档提交旧交付', 409)
      await save(`已固定代码与文档交付快照，文档目录：${documents.prefix}；未修改验收 Worktree HEAD`)
    }
    // Snapshot is made without moving the verified HEAD; retry never substitutes a new commit.
    await guard()
    await assertHarmonyHead(workspace, signal)
    const current = await snapshotCommit(workspace.harmonyRoot, workspace.baseSha, [''], workspace.artifactRoot, `verify: ${task.id}`, signal, workspace.baseSha, provisional ? await prepareDeviceConclusionDocuments(workspace, conclusion!) : await prepareBranchDocuments(workspace), workspace.harmonyHeadSha)
    if (current.tree !== state.codeSnapshot.tree) throw new CloudError('当前源码与固定交付快照不一致，停止推送，请人工核验', 409)
    const repeated = await verifyHarness(workspace, signal, provisional ? 'initialized' : 'delivery_ready')
    if (provisional) await assertDeviceConclusion(workspace, conclusion!, { ...repeated.status, codeReview: await inspectCodeReview(workspace, signal) })
    else if (repeated.raw.verified !== true) throw new CloudError('提测前证据再次校验失败', 409)
    await requireCodeReview(workspace, signal)
    if (state.priorCode) {
      const remoteSha = (await git(workspace.harmonyRoot, ['ls-remote', '--heads', source.remote, `refs/heads/${workspace.branch}`], signal)).split(/\s/)[0]
      await requireOpenMR({ ...state.priorCode, sha: remoteSha === state.codeSnapshot.sha ? state.codeSnapshot.sha : state.priorCode.sha }, signal, codeRequest)
    }
    await pushSnapshot(workspace.harmonyRoot, source.remote, workspace.branch, state.codeSnapshot.sha, signal, state.priorCode?.sha)
    state.codeCandidate = { origin: source.origin, repository: source.repository, sha: state.codeSnapshot.sha, branch: workspace.branch, target: task.targetBranch }
    await save(provisional ? '已发布附未完成设备结论的特性分支；不代表 Harness 交付通过，不自动创建代码 MR' : '已发布验收特性分支快照，不自动创建代码 MR')
    await finishCloudRun(run.id, run.leaseToken, 'awaiting_merge', `已发布特性分支：${workspace.branch}。待开发本地复核，点击确认提测后才创建集成单；本地修复不再重跑工作台转译。`)
    return
  }
  if (state.codeCandidate && (await handoffsFor([task])).get(task.id)?.status !== 'submitted') {
    await finishCloudRun(run.id, run.leaseToken, 'awaiting_merge', '待开发本地复核并确认提测，未启动转译或验收；合入后继续知识回流。')
    return
  }
  if (!state.code && state.codeCandidate) {
    state.code = (settings.transport === 'ssh-webhook' ? await mergedByWebhook(project.harmonyRoot, state.codeCandidate, signal, undefined, state.codeSnapshot?.base, !!state.integrationId) : await findDeliveryMR(state.codeCandidate, signal, codeRequest)) || undefined
    if (!state.code) {
      await finishCloudRun(run.id, run.leaseToken, 'awaiting_merge', '集成台已登记，尚未发现对应代码 MR；等待团队流程创建，后台继续监听')
      return
    }
    if (settings.transport === 'ssh-webhook') state.codeMerged = true
    await save('已关联团队创建的代码 MR')
  }
  if (!state.code) throw new CloudError('尚无交付快照，请先发布特性分支', 409)
  await guard()
  if (!state.codeMerged) {
    if (settings.transport === 'ssh-webhook') {
      const merged = await mergedByWebhook(project.harmonyRoot, state.codeCandidate || state.code, signal, state.code.iid, state.codeSnapshot?.base, !!state.integrationId)
      if (merged) { state.code = merged; state.codeMerged = true }
    } else state.codeMerged = await mergedMR(state.code, signal, codeRequest)
  }
  await save(state.codeMerged ? '已核实代码 MR 合入及源提交' : '代码 MR 尚未合入')
  if (provisional && state.codeMerged) {
    await finishCloudRun(run.id, run.leaseToken, 'completed', `代码 MR 已核实合入：${state.code.url}。设备结论未完成，严格交付文档不存在，知识回流未发布；开发本地验收结果须在集成台核对。`)
    return
  }
  if (request.action === 'publish_knowledge' || state.codeMerged && !state.knowledge) {
    if (!state.codeMerged) throw new CloudError('代码 MR 尚未合入，不能发布知识', 409)
    const checked = await verifyHarness(workspace, signal, 'delivery_ready')
    if (checked.raw.verified !== true) throw new CloudError('交付文档或证据已失效，停止回流', 409)
    const kb = record(resolveKnowledgeBase(settings.knowledgeId, loadWorkspaceAppsConfig()) || {})
    if (kb.enabled === false || typeof kb.root !== 'string') throw new CloudError('知识库未启用或不是本地 Git 内容源', 503)
    const identity = await repositoryIdentity(kb.root)
    if (state.knowledge && (state.knowledge.origin !== identity.origin || state.knowledge.repository !== identity.repository)) throw new CloudError('知识库远程身份变化，停止回流', 409)
    if (!state.knowledgeWorktree) {
      const frozen = await freezeBranch(kb.root, settings.knowledgeBranch, signal)
      const tree = await taskWorktree(frozen.cache, frozen.sha, `${workspace.identity}-docs`, 'harmony', signal)
      state.knowledgeWorktree = { root: tree.root, branch: tree.branch, base: frozen.sha }
      await save('已创建独立知识回流 Worktree')
    }
    const tree = state.knowledgeWorktree
    if (!state.knowledgeSnapshot) {
      const verification = record(JSON.parse(await readFile(path.join(workspace.runDir, 'verification-report.json'), 'utf8')))
      const values = record(verification.delivery).documents
      if (!Array.isArray(values)) throw new CloudError('交付档案缺少文档清单', 409)
      const documents = values.map(record)
      if (documents.length !== 4 || new Set(documents.map(d => d.role)).size !== 4) throw new CloudError('交付档案缺少四份核心文档', 409)
      let prefixes: string[]
      if (settings.knowledgeMode === 'feature-wiki') {
        prefixes = await prepareFeatureKnowledge({ root: tree.root, base: tree.base, workspace, code: state.code, appId: task.appId, targets: settings.knowledgeTargets!, model: task.model, title: task.title, documents, signal, guard,
          progress: async message => { await guard(); await prisma.cloudAgentEvent.create({ data: { taskId: task.id, runId: run.id, kind: 'knowledge', message } }) },
          instance: async receipt => { await prisma.cloudAgentRun.updateMany({ where: { id: run.id, status: 'running', leaseToken: run.leaseToken }, data: { instanceJson: JSON.stringify(receipt) } }) } })
      } else {
        const prefix = `${settings.knowledgePath}/${workspace.identity}`
        await mkdir(await scopedPath(tree.root, prefix, [settings.knowledgePath], true), { recursive: true })
        await bundleKnowledgeDocuments(workspace.artifactRoot, documents, await scopedPath(tree.root, prefix, [settings.knowledgePath]), verification)
        prefixes = [prefix]
      }
      state.knowledgeSnapshot = await snapshotCommit(tree.root, tree.base, prefixes, workspace.artifactRoot, `docs(${task.appId}): ${task.title}`, signal)
      await save(settings.knowledgeMode === 'feature-wiki' ? '已固定经原生校验的知识功能包与代码映射快照' : '已固定四文档归档快照')
    }
    await guard()
    const candidate = { ...identity, sha: state.knowledgeSnapshot.sha, branch: tree.branch, target: settings.knowledgeBranch }
    if (settings.transport === 'ssh-webhook') {
      state.knowledge = await mergedByWebhook(kb.root, candidate, signal, undefined, tree.base) || await pushKnowledgeMR(tree.root, identity.remote, candidate, `知识回流：${task.title}`, signal)
    } else {
      await pushSnapshot(tree.root, identity.remote, tree.branch, state.knowledgeSnapshot.sha, signal)
      state.knowledge = await ensureMR(candidate, `知识回流：${task.title}`, signal, knowledgeRequest)
    }
    await save('知识回流 MR 已创建，审核合入前不算已发布知识')
  }
  const knowledgeRoot = resolveKnowledgeBase(settings.knowledgeId, loadWorkspaceAppsConfig())?.root
  const completed = state.codeMerged && state.knowledge && (settings.transport === 'ssh-webhook'
    ? typeof knowledgeRoot === 'string' && !!await mergedByWebhook(knowledgeRoot, state.knowledge, signal, state.knowledge.iid, state.knowledgeSnapshot?.base)
    : await mergedMR(state.knowledge, signal, knowledgeRequest))
  await finishCloudRun(run.id, run.leaseToken, completed ? 'completed' : state.knowledge ? 'knowledge_review' : 'awaiting_merge', `代码 MR：${state.code.url}\n${state.knowledge ? `知识 MR：${state.knowledge.url}` : '知识回流尚未发起'}`)
}
