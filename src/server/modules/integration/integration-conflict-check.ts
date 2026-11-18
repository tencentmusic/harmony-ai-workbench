import {
  checkIntegrationMergeConflicts,
  refreshIntegrationBranchTips,
  type IntegrationMergeConflictCheckResult,
} from './integration-git'
import type { IntegrationProjectConfig } from './integration-projects'

export interface IntegrationConflictCheckTask {
  id: string
  sourceBranch: string
  targetBranch: string
}

export interface IntegrationConflictCheckResponse
  extends IntegrationMergeConflictCheckResult {
  taskId: string
  sourceBranch: string
  targetBranch: string
  headSha: string
  targetTipSha: string
  checkedAt: string
}

export class IntegrationConflictCheckBusyError extends Error {
  constructor() {
    super('冲突检测正忙')
    this.name = 'IntegrationConflictCheckBusyError'
  }
}

type ConflictCheckDependencies = {
  refreshBranchTips: typeof refreshIntegrationBranchTips
  checkMergeConflicts: typeof checkIntegrationMergeConflicts
  now(): Date
}

const DEFAULT_DEPENDENCIES: ConflictCheckDependencies = {
  refreshBranchTips: refreshIntegrationBranchTips,
  checkMergeConflicts: checkIntegrationMergeConflicts,
  now: () => new Date(),
}

const MAX_CONCURRENT_CONFLICT_CHECKS = 2
const activeChecks = new Map<string, Promise<IntegrationConflictCheckResponse>>()
let activeCheckCount = 0

export function checkLatestIntegrationTaskConflicts(
  input: {
    task: IntegrationConflictCheckTask
    project: IntegrationProjectConfig
  },
  dependencies: ConflictCheckDependencies = DEFAULT_DEPENDENCIES,
): Promise<IntegrationConflictCheckResponse> {
  const existing = activeChecks.get(input.task.id)
  if (existing) return existing
  if (activeCheckCount >= MAX_CONCURRENT_CONFLICT_CHECKS) {
    throw new IntegrationConflictCheckBusyError()
  }

  activeCheckCount += 1
  const execution = (async () => {
    const tips = await dependencies.refreshBranchTips({
      repoRoot: input.project.repoRoot,
      sourceBranch: input.task.sourceBranch,
      targetBranch: input.task.targetBranch,
    })
    const result = await dependencies.checkMergeConflicts({
      repoRoot: input.project.repoRoot,
      headSha: tips.headSha,
      targetTipSha: tips.targetTipSha,
    })
    return {
      taskId: input.task.id,
      sourceBranch: input.task.sourceBranch,
      targetBranch: input.task.targetBranch,
      headSha: tips.headSha,
      targetTipSha: tips.targetTipSha,
      ...result,
      checkedAt: dependencies.now().toISOString(),
    }
  })()
  activeChecks.set(input.task.id, execution)
  void execution.finally(() => {
    if (activeChecks.get(input.task.id) === execution) {
      activeChecks.delete(input.task.id)
    }
    activeCheckCount -= 1
  }).catch(() => {})
  return execution
}
