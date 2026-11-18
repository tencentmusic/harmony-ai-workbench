import { CloudError, record } from './domain'
import { scopedPath } from './scoped-files'
import { sourceRelativePath } from './review-source-paths'

/** Native locator proofs resolve path from cwd, unlike the task's project-relative tools. */
export async function resolveChangePaths(root: string, payload: Record<string, unknown>, registeredRoot = root) {
  async function resolveProof(value: unknown) {
    const proof = record(value)
    if (typeof proof.path !== 'string') throw new CloudError('变更与接线证据必须提供鸿蒙工程文件 path')
    const relative = await sourceRelativePath(root, registeredRoot, proof.path)
    return { ...proof, path: await scopedPath(root, relative, [''], false, true) }
  }
  const result = { ...payload }
  if (Array.isArray(payload.changes)) result.changes = await Promise.all(payload.changes.map(async value => {
    const change = record(value)
    return { ...change, ...(Array.isArray(change.files) ? { files: await Promise.all(change.files.map(resolveProof)) } : {}) }
  }))
  if (Array.isArray(payload.reachability)) result.reachability = await Promise.all(payload.reachability.map(async value => {
    const chain = record(value)
    if (!chain.proof) return chain
    const entries = await Promise.all(Object.entries(record(chain.proof)).map(async ([stage, proof]) => [stage, await resolveProof(proof)] as const))
    return { ...chain, proof: Object.fromEntries(entries) }
  }))
  return result
}
