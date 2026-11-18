import { createHash } from 'node:crypto'
import { mkdir, access, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { CloudError, CloudTransientError, validBranch } from './domain'
import { cloudRoot, git } from './git'

export interface MergeProofInput { remote: string; target: string; iid: number; sourceSha: string; mergedSha: string; baseSha?: string }
export interface MergeProof { cache: string; targetSha: string; base: string; paths: string[] }

// Independent from depth-1 source caches: concurrent task fetches cannot truncate proof history.
export async function withMergeProof<T>(input: MergeProofInput, signal: AbortSignal, action: (proof: MergeProof) => Promise<T>): Promise<T> {
  if (!validBranch(input.target) || !Number.isSafeInteger(input.iid) || input.iid < 1 || [input.sourceSha, input.mergedSha, ...(input.baseSha ? [input.baseSha] : [])].some(sha => !/^[a-f0-9]{40,64}$/.test(sha))) throw new CloudError('合入证据参数非法', 409)
  const key = createHash('sha256').update(`${input.remote}\n${input.iid}`).digest('hex')
  const parent = path.join(cloudRoot(), 'merge-proofs'), cache = path.join(parent, `${key}.git`), lock = path.join(parent, `${key}.lock`)
  await mkdir(parent, { recursive: true })
  let acquired = false
  for (let i = 0; i < 60; i++) {
    signal.throwIfAborted()
    try { await mkdir(lock); acquired = true; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!acquired) throw new CloudTransientError('合入证据缓存正在核验，稍后自动重试', 503)
  try {
    await mkdir(cache, { recursive: true })
    try { await access(path.join(cache, 'HEAD')) } catch { await git(cache, ['init', '--bare'], signal) }
    for (const depth of [64, 256, 1024, 4096]) {
      await git(cache, ['fetch', '--no-tags', `--depth=${depth}`, input.remote, `+refs/heads/${input.target}:refs/proof/target`, `+refs/merge-requests/${input.iid}/head:refs/proof/source`], signal)
      const targetSha = await git(cache, ['rev-parse', 'refs/proof/target'], signal)
      if (await git(cache, ['rev-parse', 'refs/proof/source'], signal) !== input.sourceSha) throw new CloudError('MR 源提交与已登记快照不一致', 409)
      let base: string
      try {
        await git(cache, ['merge-base', '--is-ancestor', input.mergedSha, targetSha], signal)
        const parents = (await git(cache, ['show', '-s', '--format=%P', input.mergedSha], signal)).split(' ').filter(Boolean)
        if (!parents.length) continue
        if (input.baseSha) {
          await git(cache, ['merge-base', '--is-ancestor', input.baseSha, input.sourceSha], signal)
          base = input.baseSha
        } else {
          // A fast-forward MR may contain many commits. Its last parent is not its MR base.
          if (input.mergedSha === input.sourceSha && parents.length === 1) throw new CloudError('快进合入事件缺少 diff_refs.base_sha，不能将最后一个提交误作整个 MR；请补充完整事件或手动登记需求', 409)
          base = await git(cache, ['merge-base', parents[0], input.sourceSha], signal)
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof CloudError) || error.status !== 503) throw error
        continue
      }
      const paths = (await git(cache, ['diff', '--name-only', '--no-renames', '-z', base, input.sourceSha], signal)).split('\0').filter(Boolean)
      if (!paths.length || paths.length > 2000) throw new CloudError('MR 变更为空或超出核验范围', 409)
      return await action({ cache, targetSha, base, paths })
    }
    throw new CloudError('在限量 Git 历史中无法证明合入提交属于目标分支或定位 MR 基线；请核验事件与仓库历史，不会跳过核验', 409)
  } finally { await rmdir(lock) }
}
