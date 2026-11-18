import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { androidSyncSources, cloudProjects } from './config'
import { CloudError, parseMergedEvent, record } from './domain'
import { git, inScope, repositoryIdentity, sourceRelativePath } from './git'
import { withMergeProof } from './merge-proof'
import { wakeDeliveryForMerge } from './delivery-automation'

class IrrelevantEvent extends Error {}

export async function receiveCloudWebhook(body: unknown) {
  const event = parseMergedEvent(body)
  if (!event) return { accepted: false, reason: 'not_merged_mr' }
  const identity = createHash('sha256').update(`${event.origin}/${event.projectId}/${event.iid}`).digest('hex')
  await prisma.$transaction(async tx => {
    const previous = await tx.cloudAgentInbox.findUnique({ where: { identity } })
    if (!previous) { await tx.cloudAgentInbox.create({ data: { identity, payload: JSON.stringify(event) } }); return }
    const old = record(JSON.parse(previous.payload))
    for (const key of ['origin', 'repository', 'projectId', 'iid', 'branch', 'sourceBranch', 'sourceSha', 'mergedSha', 'sourceProjectId', 'baseSha'] as const) {
      if (old[key] !== undefined && event[key] !== undefined && old[key] !== event[key]) throw new CloudError('重复 MR 合入事件与已保存证据冲突', 409)
    }
    const additions = Object.fromEntries(Object.entries(event).filter(([key, value]) => old[key] === undefined && value !== undefined))
    if (Object.keys(additions).length && previous.status !== 'running') await tx.cloudAgentInbox.update({ where: { id: previous.id }, data: { payload: JSON.stringify({ ...old, ...additions }), ...(previous.status === 'blocked' ? { status: 'queued', attempts: 0, error: null, nextAttempt: new Date() } : {}) } })
  })
  return { accepted: true, identity }
}
export async function readMergedGitEvent(root: string, event: Record<string, unknown>) {
  if (typeof event.mergedSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(event.mergedSha) || typeof event.sourceSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(event.sourceSha) || typeof event.sourceBranch !== 'string') throw new CloudError('合入 Webhook 缺少源分支/源提交/合入提交，请重新发送完整 MR 合入事件', 409)
  const signal = AbortSignal.timeout(120000)
  const identity = await repositoryIdentity(root)
  if (identity.origin !== event.origin || identity.repository !== event.repository) throw new CloudError('Android 仓库身份不一致', 409)
  return withMergeProof({ remote: identity.remote, target: String(event.branch), iid: Number(event.iid), sourceSha: event.sourceSha, mergedSha: event.mergedSha, baseSha: typeof event.baseSha === 'string' ? event.baseSha : undefined }, signal, async ({ cache, base, paths: names }) => {
  if (!names.length || names.length > 100) throw new CloudError('Android MR 变更为空或超过100文件，需要明确范围', 409)
  const changes = []
  for (const name of names) changes.push({ old_path: name, new_path: name, diff: await git(cache, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', base, String(event.mergedSha), '--', `:(literal)${name}`], signal) })
  return { repository: { path_with_namespace: event.repository }, mr: { state: 'merged', project_id: event.projectId, iid: event.iid, target_branch: event.branch, merge_commit_sha: event.mergedSha,
    title: event.title, description: event.description, diff_refs: { base_sha: base, head_sha: event.sourceSha } }, diffData: { changes } }
  })
}
export async function processCloudInbox(dependencies = { sources: androidSyncSources, projects: cloudProjects, identity: repositoryIdentity, get: null as ((origin: string, endpoint: string) => Promise<unknown>) | null }) {
  const candidate = await prisma.cloudAgentInbox.findFirst({ where: { status: 'queued', nextAttempt: { lte: new Date() } }, orderBy: { createdAt: 'asc' } })
  if (!candidate) return
  const leaseToken = randomBytes(24).toString('hex')
  const claimed = await prisma.cloudAgentInbox.updateMany({ where: { id: candidate.id, status: 'queued' }, data: { status: 'running', leaseToken, leaseUntil: new Date(Date.now() + 180_000), attempts: { increment: 1 } } })
  if (!claimed.count) return
  try {
    const event = record(JSON.parse(candidate.payload))
    if (await wakeDeliveryForMerge(event)) {
      await prisma.cloudAgentInbox.updateMany({ where: { id: candidate.id, status: 'running', leaseToken }, data: { status: 'done', error: null } })
      return
    }
    const sources = dependencies.sources().filter(source => source.branches.includes(String(event.branch)))
    const matched: (ReturnType<typeof androidSyncSources>[number] & { sourcePrefix: string })[] = []
    let unavailable = false
    for (const source of sources) {
      try {
        const remote = await dependencies.identity(source.root)
        if (remote.origin === event.origin && remote.repository === event.repository) matched.push({ ...source, sourcePrefix: remote.sourcePrefix })
      } catch { unavailable = true }
    }
    if (!matched.length) {
      if (unavailable) throw new CloudError('Android 来源仓库不可访问，暂不能核验 MR 来源', 503)
      throw new IrrelevantEvent('非已配置的 Android 监听仓库及分支')
    }
    const origin = String(event.origin)
    const root = `/projects/${Number(event.projectId)}/merge_requests/${Number(event.iid)}`
    const verified = dependencies.get ? null : await readMergedGitEvent(matched[0].root, event)
    const repository = record(verified ? verified.repository : await dependencies.get!(origin, `/projects/${Number(event.projectId)}`))
    if (repository.path_with_namespace !== event.repository) throw new CloudError('MR 仓库身份不一致')
    const mr = record(verified ? verified.mr : await dependencies.get!(origin, root))
    if (mr.state !== 'merged' || mr.target_branch !== event.branch || mr.project_id !== event.projectId || mr.iid !== event.iid) throw new CloudError('MR 合入事实、仓库或编号不一致')
    const diffData = record(verified ? verified.diffData : await dependencies.get!(origin, `${root}/changes`))
    if (diffData.overflow === true || !Array.isArray(diffData.changes) || diffData.changes.length > 100) throw new CloudError('MR 变更不完整或过大，需人工处理')
    const changes = diffData.changes.map(record)
    const affects = (change: Record<string, unknown>, source: typeof matched[number], prefixes: string[]) => [change.old_path, change.new_path].some(file => {
      if (typeof file !== 'string') return false
      const relative = sourceRelativePath(file, source.sourcePrefix)
      return relative !== null && inScope(source.suffix ? `${source.suffix}/${relative}` : relative, prefixes)
    })
    const apps = dependencies.projects().filter(app => app.mrTrigger && matched.some(source => source.projectIds.includes(app.projectId) && changes.some(change => affects(change, source, app.androidPrefixes))))
    if (!apps.length) throw new IrrelevantEvent('MR 未命中已启用 App 的模块范围')
    if (apps.length !== 1) throw new CloudError('MR 涉及多个 App，需人工分派')
    const app = apps[0]
    const source = matched.find(source => source.projectIds.includes(app.projectId) && changes.some(change => affects(change, source, app.androidPrefixes)))!
    const sha = mr.merge_commit_sha || mr.squash_commit_sha
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('缺少最终合入提交，需核验')
    const diff = changes.filter(change => affects(change, source, app.androidPrefixes))
      .map(change => ({ old_path: change.old_path, new_path: change.new_path, diff: typeof change.diff === 'string' ? change.diff.slice(0, 10000) : '' }))
    const diffTruncated = JSON.stringify(diff).length > 40000 || changes.some(change => change.collapsed === true || change.too_large === true || (typeof change.diff === 'string' && change.diff.length > 10000))
    const material = `Android MR !${event.iid}\n${String(mr.title || '')}\n${String(mr.description || '').slice(0, 12000)}\n目标分支 ${event.branch}\n合入提交 ${sha}\n变更（受限摘录，需核验上下文）：\n${JSON.stringify(diff).slice(0, 40000)}`
    const originKey = `${candidate.identity}:${app.id}`
    await prisma.$transaction(async tx => {
      if (await tx.cloudAgentTask.count({ where: { status: 'queued' } }) >= 100) throw new CloudError('分析队列已满，稍后重试 MR', 503)
      const owned = await tx.cloudAgentInbox.updateMany({ where: { id: candidate.id, status: 'running', leaseToken }, data: { status: 'done', error: null } })
      if (!owned.count) throw new CloudError('MR 处理租约失效', 409)
      await tx.cloudAgentTask.upsert({ where: { originKey }, update: {}, create: { appId: app.id, title: String(mr.title || `MR !${event.iid}`).slice(0, 160), material, targetBranch: app.defaultBranch,
        model: app.model, source: 'android-mr', sourceUrl: `${origin}/${event.repository}/-/merge_requests/${event.iid}`, originKey,
        sourceSnapshot: JSON.stringify({ ...event, sourceId: source.id, mergedSha: sha, diffRefs: mr.diff_refs, diffTruncated }), events: { create: { kind: 'created', message: 'Android MR 已合入，已自动匹配 App 和鸿蒙分支，等待分析' } } } })
    })
  } catch (error) {
    const temporary = error instanceof CloudError && error.status === 503
    await prisma.cloudAgentInbox.updateMany({ where: { id: candidate.id, status: 'running', leaseToken }, data: { status: error instanceof IrrelevantEvent ? 'ignored' : temporary && candidate.attempts < 4 ? 'queued' : 'blocked',
      error: error instanceof CloudError || error instanceof IrrelevantEvent ? error.message : 'MR 处理失败，等待人工核验', nextAttempt: new Date(Date.now() + Math.min(900_000, 30_000 * 2 ** candidate.attempts)) } })
  }
}
