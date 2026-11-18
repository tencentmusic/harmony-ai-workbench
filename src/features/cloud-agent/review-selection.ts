import type { CloudReview, CloudTask } from '@/contracts/cloud-agent'

export function approvalOptions(task: CloudTask): CloudReview[] {
  return (['scope', 'ui'] as const).flatMap(kind => {
    const review = task.review?.kind === kind ? task.review : task.approvedReviews?.find(item => item.kind === kind)
    return review?.materialVersion === task.materialVersion ? [review] : []
  })
}
export function selectedApproval(task: CloudTask, kind?: 'scope' | 'ui'): CloudReview | null {
  const options = approvalOptions(task)
  return options.find(item => item.kind === kind) || options.find(item => item.digest === task.review?.digest) || options.find(item => item.kind === 'ui') || options[0] || null
}
export function isPendingReview(task: CloudTask, review: CloudReview): boolean {
  return task.status === 'awaiting_approval' && task.actions.includes('approve') && task.review?.digest === review.digest && task.review.kind === review.kind && review.materialVersion === task.materialVersion && task.runs[0]?.materialVersion === task.materialVersion
}
