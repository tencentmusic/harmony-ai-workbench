import { CloudError, record } from './domain'

export function assertUiReviewRecovery(value: unknown, operationId: string) {
  const facts = record(value)
  const operation = record(facts.operation || {})
  if (facts.uiStatus !== 'pending') throw new CloudError('原生UI审批已变化，不能按失败登记恢复', 409)
  if (!Array.isArray(facts.pending) || facts.pending.length) throw new CloudError('存在未决原生操作，必须先核验收据', 409)
  if (operation.operation_id !== operationId || operation.command !== 'review-ui' || operation.status !== 'failed') {
    throw new CloudError('仅明确失败的UI登记可使用新操作号恢复，未知或已提交操作不可重放', 409)
  }
}

export function assertUiReviewReconciliation(value: unknown, operationId: string, expected: { reference: string; actorId: string; reason: string; decision: string }) {
  const facts = record(value), operation = record(facts.operation || {}), receipt = record(facts.uiReview || {})
  if (!['approved', 'not_applicable'].includes(expected.decision) || facts.uiStatus !== expected.decision || receipt.status !== expected.decision ||
    receipt.approval_reference !== expected.reference || receipt.reviewer_kind !== 'human' || receipt.reviewer !== expected.actorId || receipt.basis !== expected.reason) {
    throw new CloudError('原生UI收据与原始人工确认不一致，不能恢复完成凭据', 409)
  }
  if (operation.operation_id !== operationId || operation.command !== 'review-ui' || operation.status !== 'started' ||
    !Array.isArray(facts.pending) || facts.pending.length !== 1 || facts.pending[0] !== operationId) {
    throw new CloudError('只能核对当前UI操作的未决收据，不能恢复未知操作或重复批准', 409)
  }
}
