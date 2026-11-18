import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import { CloudError, record } from './domain'
import { harnessRoot, harnessEnvironment, harnessCodeFacts, verifyHarness, type HarnessWorkspace } from './harness'
import { requireChildProcessesStopped, requireHarnessJournalSettled } from './process-recovery'
import { inspectCodeReview } from './code-review'
import { acquireResource } from './resource-lock'

const execute = promisify(execFile)

// Local operator entry only. No Agent tool or HTTP route exposes source relocation.
export async function relocateCloudWorktree(id: string, destination: string) {
  if (!path.isAbsolute(destination) || /[\x00-\x1f]/.test(destination) || path.resolve(destination) === path.parse(destination).root) throw new CloudError('迁移目标必须是专用绝对目录')
  const target = path.resolve(destination)
  const signal = AbortSignal.timeout(600000)
  const release = await acquireResource('source-relocation', id, `operator:${process.pid}`, signal)
  try {
    const task = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id } })
    if (!['harness_waiting', 'blocked', 'failed', 'awaiting_approval', 'approved'].includes(task.status)) throw new CloudError('任务必须先停止再迁移', 409)
    if (await prisma.cloudAgentRun.count({ where: { taskId: id, status: { in: ['running', 'queued', 'recovery_required'] } } })) throw new CloudError('任务仍有活跃或未恢复运行', 409)
    const saved = record(JSON.parse(task.harnessJson))
    const w = saved.workspace as HarnessWorkspace
    if (!w?.continuous || !w.harmonyRoot || !w.runDir) throw new CloudError('任务缺少原始工作区', 409)
    const previous = record(saved.worktreeRelocation || {})
    if (previous.target && previous.target !== target) throw new CloudError('已登记其他迁移目标，请先恢复原操作', 409)
    if (previous.status === 'completed') return { taskId: id, target, status: 'completed' }
    await requireChildProcessesStopped(w.artifactRoot)
    await requireHarnessJournalSettled(w.runDir)
    const out = path.join(w.artifactRoot, 'worktree-relocation')
    await mkdir(out, { recursive: true })
    const file = path.join(out, 'workbench-before.json')
    let backup: { taskId: string; target: string; harnessJson: string; digest: string; reviewPassed: boolean }
    const old = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (old) backup = JSON.parse(old)
    else {
      backup = { taskId: id, target, harnessJson: task.harnessJson, digest: (await harnessCodeFacts(w, signal)).digest,
        reviewPassed: (await inspectCodeReview(w, signal)).status === 'passed' }
      await writeFile(file, JSON.stringify(backup, null, 2), { flag: 'wx' })
    }
    if (backup.taskId !== id || backup.target !== target) throw new CloudError('迁移备份身份不匹配', 409)
    const moving = { ...saved, worktreeRelocation: { status: 'moving', target, originalRoot: w.harmonyRoot } }
    const claimed = await prisma.cloudAgentTask.updateMany({ where: { id, revision: task.revision, status: task.status, harnessJson: task.harnessJson }, data: { harnessJson: JSON.stringify(moving), revision: { increment: 1 } } })
    if (!claimed.count) throw new CloudError('任务已变化，未移动工作树', 409)
    const script = path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/relocate_worktree.py')
    await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', script, '--run-dir', w.runDir, '--target', target, '--node', process.execPath],
      { signal, timeout: 180000, windowsHide: true, env: harnessEnvironment(), maxBuffer: 2 * 1024 * 1024 })
    const next = { ...w, harmonyRoot: target }
    if ((await harnessCodeFacts(next, signal)).digest !== backup.digest) throw new CloudError('迁移后代码或证据摘要变化，已停止恢复', 409)
    if (backup.reviewPassed && (await inspectCodeReview(next, signal)).status !== 'passed') throw new CloudError('原静态审查未通过迁移复核', 409)
    const checked = await verifyHarness(next, signal)
    await prisma.$transaction(async tx => {
      const updated = await tx.cloudAgentTask.updateMany({ where: { id, revision: task.revision + 1, harnessJson: JSON.stringify(moving) },
        data: { harnessJson: JSON.stringify({ ...moving, workspace: next, status: checked.status, worktreeRelocation: { ...moving.worktreeRelocation, status: 'completed' } }), revision: { increment: 1 } } })
      if (!updated.count) throw new CloudError('迁移期间任务变化，需运维恢复', 409)
      await tx.cloudAgentEvent.create({ data: { taskId: id, kind: 'worktree-relocated', message: `任务工作树已迁到 ${target}；原分支、源码摘要和审核证据复核一致。旧路径保留为历史文档入口，未声明构建或验收通过。` } })
    })
    return { taskId: id, target, status: 'completed', phase: checked.status.phase }
  } finally { await release() }
}
