import { prisma } from '@/lib/prisma'
import { CloudError, record, validBranch } from './domain'
import { repositoryIdentity, git } from './git'
import { withMergeProof } from './merge-proof'
import type { DeliveryMR } from './delivery-git'

type Candidate = Omit<DeliveryMR, 'iid' | 'url'>
export function mergeEventMatches(event: Record<string, unknown>, expected: Candidate, iid?: number, handedOff = false) {
  return event.origin === expected.origin && event.repository === expected.repository && event.branch === expected.target && event.sourceBranch === expected.branch && (event.sourceSha === expected.sha || handedOff && typeof event.sourceSha === 'string' && /^[a-f0-9]{40,64}$/.test(event.sourceSha)) &&
    Number.isSafeInteger(event.iid) && Number(event.iid) > 0 && (iid === undefined || event.iid === iid) &&
    (event.sourceProjectId === undefined || event.sourceProjectId === event.projectId) && typeof event.mergedSha === 'string' && /^[a-f0-9]{40,64}$/.test(event.mergedSha)
}

export async function findMergedReceipt(expected: Candidate, iid?: number, handedOff = false) {
  const records = await prisma.cloudAgentInbox.findMany({ where: { AND: [{ payload: { contains: JSON.stringify(expected.repository) } }, { payload: { contains: handedOff ? JSON.stringify(expected.branch) : expected.sha } }] }, orderBy: { createdAt: 'desc' }, take: 100 })
  const matches = records.map(row => record(JSON.parse(row.payload))).filter(event => mergeEventMatches(event, expected, iid, handedOff))
  if (new Set(matches.map(event => event.iid)).size > 1) throw new CloudError('同一交付快照存在多个合入 MR，需核验', 409)
  return matches[0] || null
}

export async function verifyAcceptedFiles(root: string, sourceSha: string, mergedSha: string, paths: string[], signal: AbortSignal) {
  const accepted = new Set(paths)
  // Filter output instead of passing thousands of paths through the Windows command line.
  const changed = (await git(root, ['diff', '--name-only', '--no-renames', '-z', sourceSha, mergedSha], signal)).split('\0').filter(Boolean)
  if (changed.some(file => accepted.has(file))) throw new CloudError('合入代码与已验收快照不同，需要重新验收，未发布知识', 409)
}

export async function verifyMergeCommit(root: string, targetSha: string, mergedSha: string, sourceSha: string, signal: AbortSignal) {
  for (const sha of [targetSha, mergedSha, sourceSha]) if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new CloudError('合入提交格式非法', 409)
  await git(root, ['merge-base', '--is-ancestor', mergedSha, targetSha], signal)
  const parents = (await git(root, ['show', '-s', '--format=%P', mergedSha], signal)).split(' ').filter(Boolean)
  if (!parents.length) throw new CloudError('合入提交缺少父提交，不能核验', 409)
  const base = await git(root, ['merge-base', parents[0], sourceSha], signal)
  const paths = (await git(root, ['diff', '--name-only', '--no-renames', '-z', base, sourceSha], signal)).split('\0').filter(Boolean)
  if (!paths.length || paths.length > 2000) throw new CloudError('合入变更为空或超出核验范围', 409)
  // Covers merge, fast-forward and squash without accepting conflict-resolution changes to the accepted files.
  await verifyAcceptedFiles(root, sourceSha, mergedSha, paths, signal)
}

export async function verifyHandoffSource(root: string, acceptedSha: string, sourceSha: string, signal: AbortSignal) {
  if (![acceptedSha, sourceSha].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) throw new CloudError('交接提交格式非法', 409)
  try { await git(root, ['merge-base', '--is-ancestor', acceptedSha, sourceSha], signal) }
  catch { signal.throwIfAborted(); throw new CloudError('开发合入提交不包含原交付提交，请核对分支历史；不会自动重跑转译', 409) }
}

export async function mergedByWebhook(root: string, expected: Candidate, signal: AbortSignal, iid?: number, baseSha?: string, handedOff = false): Promise<DeliveryMR | null> {
  const event = await findMergedReceipt(expected, iid, handedOff)
  if (!event) return null
  const identity = await repositoryIdentity(root)
  if (identity.origin !== expected.origin || identity.repository !== expected.repository) throw new CloudError('合入核验仓库配置与交付快照不一致', 409)
  const sourceSha = String(event.sourceSha)
  const sourceRoot = await withMergeProof({ remote: identity.remote, target: expected.target, iid: Number(event.iid), sourceSha, mergedSha: String(event.mergedSha), baseSha }, signal, async ({ cache, paths }) => {
    if (handedOff) await verifyHandoffSource(cache, expected.sha, sourceSha, signal)
    await verifyAcceptedFiles(cache, sourceSha, String(event.mergedSha), paths, signal)
    return cache
  })
  return { ...expected, sha: sourceSha, mergedSha: String(event.mergedSha), sourceRoot, iid: Number(event.iid), url: `${expected.origin}/${expected.repository}/-/merge_requests/${event.iid}` }
}

export function mrFromPush(output: string, expected: Candidate): DeliveryMR | null {
  const urls = output.match(/https?:\/\/[^\s<>\x1b]+\/merge_requests\/[0-9]+\b/g) || []
  const values = urls.flatMap(value => {
    const url = new URL(value), match = /\/merge_requests\/(\d+)$/.exec(url.pathname)
    if (url.origin !== expected.origin || ![ `/${expected.repository}/-/merge_requests/${match?.[1]}`, `/${expected.repository}/merge_requests/${match?.[1]}` ].includes(url.pathname) || url.username || url.password || url.search || url.hash) return []
    return [{ ...expected, iid: Number(match![1]), url: url.href }]
  })
  if (new Set(values.map(value => value.iid)).size > 1) throw new CloudError('Git 推送返回多个 MR，需核验', 409)
  return values[0] || null
}

export async function pushKnowledgeMR(root: string, remote: string, expected: Candidate, title: string, signal: AbortSignal) {
  if (!validBranch(expected.branch) || !validBranch(expected.target) || !/^[a-f0-9]{40,64}$/.test(expected.sha) || /[\r\n\0]/.test(title)) throw new CloudError('知识 MR 参数非法', 409)
  if (!/^git@[^:]+:.+|^ssh:\/\//.test(remote)) throw new CloudError('无 Token 交付要求知识仓 origin 使用 SSH', 503)
  const ref = `refs/heads/${expected.branch}`
  const current = (await git(root, ['ls-remote', '--heads', remote, ref], signal)).split(/\s/)[0]
  if (current && current !== expected.sha) throw new CloudError('知识分支已被其他提交占用，未覆盖', 409)
  if (current === expected.sha) throw new CloudError(`知识分支已推送但 MR 回执缺失，请在仓库检查并创建 MR；保留原快照，不制造空提交。合入 Webhook 到达后可继续。`, 409)
  const output = await git(root, ['push', `--force-with-lease=${ref}:`, '-o', 'merge_request.create', '-o', `merge_request.target=${expected.target}`, '-o', `merge_request.title=${title}`, remote, `${expected.sha}:${ref}`], signal, {}, true)
  const mr = mrFromPush(output, expected)
  if (!mr) throw new CloudError('分支已推送，但服务端未返回 MR 链接；请核对 GitLab push options 支持和已有 MR', 409)
  return mr
}
