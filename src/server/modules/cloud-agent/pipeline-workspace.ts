import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { cloudProject, branchAllowed, androidSyncSources } from './config'
import { cloudRoot, freezeBranch, git, repositoryIdentity, repositoryIssue, sourcePrefixes } from './git'
import { taskWorktree } from './worktrees'
import { CloudError, record } from './domain'
import type { HarnessWorkspace } from './harness'
import type { claimCloudRun } from './store'
import { sha256 } from './scoped-files'
import { checkCloudCapacity } from './capacity'
import { prepareAndroidSources } from './android-sources'
import { assertHarmonyHead } from './harmony-head'

export async function preparePipelineWorkspace(claim: NonNullable<Awaited<ReturnType<typeof claimCloudRun>>>, signal: AbortSignal): Promise<HarnessWorkspace> {
  const { task, run } = claim
  await checkCloudCapacity()
  const project = cloudProject(task.appId)
  const configDigest = (source: { id: string; root: string; suffix: string; branches: string[] }) => sha256(JSON.stringify({ android: project.androidRoot, harmony: project.harmonyRoot, source }))
  if (!branchAllowed(project, task.targetBranch)) throw new CloudError('目标分支已不在许可范围', 403)
  const saved = record(JSON.parse(task.harnessJson))
  if (saved.worktreeRelocation && record(saved.worktreeRelocation).status !== 'completed') throw new CloudError('工作树迁移未完成，请运维继续原迁移操作', 409)
  const old = saved.workspace as HarnessWorkspace | undefined
  const nodes = record(saved.status || {}).nodes
  const reviewed = !!saved.reviewCommitted || Array.isArray(nodes) && nodes.some(node => node.id === 'scope_approved' && node.status === 'passed')
  if (old?.continuous && (old.materialVersion === run.materialVersion || !reviewed)) {
    if (old.documentsPath && old.documentsPath !== project.documentsPath) throw new CloudError('任务文档归档目录已变化，请恢复原配置或新建任务', 409)
    if (old.appId !== task.appId || old.targetBranch !== task.targetBranch || JSON.stringify(old.harmonyPrefixes) !== JSON.stringify(project.harmonyPrefixes) || JSON.stringify(old.androidPrefixes) !== JSON.stringify(sourcePrefixes(project.androidPrefixes, old.androidSourceSuffix || ''))) throw new CloudError('项目配置已变化，需新建任务重新核验', 409)
    const source = androidSyncSources().find(item => item.id === old.androidSourceId && item.projectIds.includes(project.projectId))
    if (!source || source.suffix !== (old.androidSourceSuffix || '') || old.sourceConfigDigest !== configDigest(source)) throw new CloudError('源码来源配置已变化，需新建任务重新核验', 409)
    await assertHarmonyHead(old, signal)
    if (await git(old.androidRoot, ['rev-parse', 'HEAD'], signal) !== old.androidSha) throw new CloudError('任务 Android Worktree 基线被外部修改，需人工恢复', 409)
    if (reviewed && !old.androidSources) throw new CloudError('已审批旧任务缺少完整源码快照，请新建任务重新分析', 409)
    const snapshot = record(JSON.parse(task.sourceSnapshot))
    return prepareAndroidSources({ ...old, documentsPath: project.documentsPath, materialVersion: run.materialVersion }, project, signal, task.source === 'android-mr' ? { sourceId: String(snapshot.sourceId), sha: String(snapshot.mergedSha), branch: String(snapshot.branch) } : undefined)
  }
  if (run.kind !== 'analysis') throw new CloudError('旧流程或材料变更后必须重新分析，不能沿用旧批准', 409)
  for (const root of [project.androidRoot, project.harmonyRoot]) {
    const issue = await repositoryIssue(root)
    if (issue) throw new CloudError(issue, 503)
  }
  const sourceSnapshot = record(JSON.parse(task.sourceSnapshot))
  const sources = androidSyncSources().filter(source => source.projectIds.includes(project.projectId))
  const source = sources.find(item => !item.suffix)
  const mrSource = task.source === 'android-mr' ? sources.find(item => item.id === sourceSnapshot.sourceId) : undefined
  if (!source?.branches[0]) throw new CloudError('未配置可用 Android 来源分支', 503)
  const branch = mrSource?.id === source.id ? String(sourceSnapshot.branch) : source.branches[0]
  if (!source.branches.includes(branch)) throw new CloudError('Android 来源分支已变化', 409)
  if (task.source === 'android-mr') {
    if (!mrSource || !mrSource.branches.includes(String(sourceSnapshot.branch))) throw new CloudError('MR 来源分支未配置', 409)
    const identity = await repositoryIdentity(mrSource.root)
    if (identity.origin !== sourceSnapshot.origin || identity.repository !== sourceSnapshot.repository || typeof sourceSnapshot.mergedSha !== 'string') throw new CloudError('MR 来源身份或固定提交无效', 409)
  }
  const harmony = await freezeBranch(project.harmonyRoot, task.targetBranch, signal)
  const android = await freezeBranch(source.root, branch, signal, mrSource?.id === source.id ? String(sourceSnapshot.mergedSha) : undefined)
  const identity = `${task.id}-${run.revision}`
  const target = await taskWorktree(harmony.cache, harmony.sha, identity, 'harmony', signal)
  const origin = await taskWorktree(android.cache, android.sha, identity, 'android', signal)
  const artifactRoot = path.join(cloudRoot(), 'tasks', identity, 'artifacts')
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  return prepareAndroidSources({ runtimeVersion: 1, continuous: true, materialVersion: run.materialVersion, targetBranch: task.targetBranch, androidSha: android.sha, androidSourceId: source.id, sourceConfigDigest: configDigest(source),
    identity, artifactRoot, documentsPath: project.documentsPath, runDir: path.join(artifactRoot, 'harness'), androidRoot: path.join(origin.root, android.identity.sourcePrefix), harmonyRoot: path.join(target.root, harmony.identity.sourcePrefix),
    branch: target.branch, baseSha: harmony.sha, androidPrefixes: sourcePrefixes(project.androidPrefixes, source.suffix), harmonyPrefixes: project.harmonyPrefixes,
    androidSourceSuffix: source.suffix, appId: task.appId, title: task.title, profile: path.join(artifactRoot, 'project-profile.md') }, project, signal, mrSource ? { sourceId: mrSource.id, sha: String(sourceSnapshot.mergedSha), branch: String(sourceSnapshot.branch) } : undefined)
}
