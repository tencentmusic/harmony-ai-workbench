import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import { record } from './domain'
import { scopedPath } from './scoped-files'
import type { NativeReview } from './harness-review'

// Resolve only decisions referenced by this workspace's native receipts, never an arbitrary latest approval.
export async function approvedReviews(task: { id: string; materialVersion: number; harnessJson: string }): Promise<NativeReview[]> {
  const saved = record(JSON.parse(task.harnessJson)), workspace = record(saved.workspace || {})
  if (!workspace.continuous || workspace.materialVersion !== task.materialVersion || typeof workspace.identity !== 'string' || typeof workspace.artifactRoot !== 'string' || typeof workspace.runDir !== 'string') return []
  let parity: Record<string, unknown>
  try {
    const relative = path.relative(workspace.artifactRoot, path.join(workspace.runDir, 'parity-matrix.json')).replaceAll('\\', '/')
    parity = record(JSON.parse(await readFile(await scopedPath(workspace.artifactRoot, relative, [''], true), 'utf8')))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const prefix = `cloud-agent:${workspace.identity}:approval:`
  const refs = (['scope', 'ui'] as const).flatMap(kind => {
    const receipt = record(parity[kind === 'scope' ? 'scope_approval' : 'ui_review'] || {})
    const ref = receipt.approval_reference
    return (receipt.status === 'approved' || kind === 'ui' && receipt.status === 'not_applicable') && typeof ref === 'string' && ref.startsWith(prefix)
      ? [{ kind, id: ref.slice(prefix.length) }] : []
  })
  if (!refs.length) return []
  const approvals = await prisma.cloudAgentApproval.findMany({ where: { taskId: task.id, id: { in: refs.map(ref => ref.id) } }, select: { id: true, decision: true, digest: true, payload: true } })
  return refs.flatMap(ref => {
    const approval = approvals.find(item => item.id === ref.id && item.decision === ref.kind)
    if (!approval) return []
    const review = JSON.parse(approval.payload) as NativeReview
    if (review.kind !== ref.kind || review.digest !== approval.digest || review.materialVersion !== task.materialVersion || !Array.isArray(review.files)) return []
    return [review]
  })
}
