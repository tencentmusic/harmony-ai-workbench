import { git } from './git'
import { CloudError } from './domain'

type HarmonyHead = { harmonyRoot: string; branch: string; baseSha: string; harmonyHeadSha?: string }

export async function assertHarmonyHead(workspace: HarmonyHead, signal: AbortSignal) {
  const expected = workspace.harmonyHeadSha ?? workspace.baseSha
  if (![expected, workspace.baseSha].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) throw new CloudError('任务提交身份无效', 409)
  if (await git(workspace.harmonyRoot, ['branch', '--show-current'], signal) !== workspace.branch) throw new CloudError('任务鸿蒙分支已变化，停止写入', 409)
  if (await git(workspace.harmonyRoot, ['rev-parse', 'HEAD'], signal) !== expected) throw new CloudError('任务鸿蒙 HEAD 未登记，需核验外部提交后恢复', 409)
  if (expected !== workspace.baseSha) {
    const ancestor = await git(workspace.harmonyRoot, ['merge-base', workspace.baseSha, expected], signal).catch(() => {
      signal.throwIfAborted()
      throw new CloudError('无法确认登记提交与原始基线的继承关系，停止写入', 409)
    })
    if (ancestor !== workspace.baseSha) throw new CloudError('登记提交不是原始基线的后继，停止写入', 409)
  }
}
