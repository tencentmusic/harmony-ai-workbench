export type IntegrationTaskStatus =
  | 'developing'
  | 'submitted'
  | 'merge_pending'
  | 'merged'
  | 'closed'

export type IntegrationStage = 'submit_review_and_tests' | 'pre_merge_review'

export type IntegrationArtifactType = 'initial_review' | 'test_cases' | 'final_review'

export const INTEGRATION_FEATURE_DESCRIPTION_MAX_LENGTH = 4_000
export const INTEGRATION_REVIEW_NOTE_MAX_LENGTH = 4_000

const RERUNNABLE_STAGES_BY_STATUS = Object.freeze({
  developing: [],
  submitted: ['submit_review_and_tests'],
  merge_pending: ['submit_review_and_tests', 'pre_merge_review'],
  merged: ['submit_review_and_tests', 'pre_merge_review'],
  closed: [],
} as const satisfies Readonly<Record<IntegrationTaskStatus, readonly IntegrationStage[]>>)

const MAX_GIT_BRANCH_NAME_LENGTH = 255
const UNSAFE_MULTILINE_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/

export const ALLOWED_INTEGRATION_TRANSITIONS = {
  developing: ['submitted', 'closed'],
  submitted: ['merge_pending', 'closed'],
  merge_pending: ['merged', 'closed'],
  merged: [],
  closed: [],
} as const satisfies Readonly<Record<IntegrationTaskStatus, readonly IntegrationTaskStatus[]>>

export function isAllowedIntegrationTransition(
  from: IntegrationTaskStatus,
  to: IntegrationTaskStatus,
): boolean {
  if (from === to) return true

  return (ALLOWED_INTEGRATION_TRANSITIONS[from] as readonly IntegrationTaskStatus[]).includes(to)
}

export function resolveTriggeredStage(
  from: IntegrationTaskStatus,
  to: IntegrationTaskStatus,
): IntegrationStage | null {
  if (from === to) return null

  if (!isAllowedIntegrationTransition(from, to)) {
    throw new Error(`非法的集成任务状态跳转：${from} -> ${to}`)
  }

  if (from === 'developing' && to === 'submitted') {
    return 'submit_review_and_tests'
  }

  if (from === 'submitted' && to === 'merge_pending') {
    return 'pre_merge_review'
  }

  return null
}

export function resolveRerunnableIntegrationStages(
  status: IntegrationTaskStatus,
): readonly IntegrationStage[] {
  return RERUNNABLE_STAGES_BY_STATUS[status]
}

export function isIntegrationReviewArtifact(
  type: string,
): type is Extract<IntegrationArtifactType, 'initial_review' | 'final_review'> {
  return type === 'initial_review' || type === 'final_review'
}

export function isValidGitBranchName(branch: string): boolean {
  if (!branch || branch !== branch.trim()) return false
  if (branch.length > MAX_GIT_BRANCH_NAME_LENGTH) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false
  if (branch === '.' || branch.includes('..') || branch.includes('//')) return false
  if (branch.endsWith('/') || branch.endsWith('.')) return false
  if (/(?:^|\/)\./.test(branch)) return false
  if (/(?:^|\/)[^/]*\.lock(?:\/|$)/i.test(branch)) return false

  return true
}

export function hasUnsafeMultilineControlCharacters(value: string): boolean {
  return UNSAFE_MULTILINE_CONTROL_CHARACTER_PATTERN.test(value)
}
