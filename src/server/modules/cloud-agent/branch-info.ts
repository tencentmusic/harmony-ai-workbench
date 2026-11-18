import type { CloudTask } from '@/contracts/cloud-agent'

export function taskBranchInfo(harnessJson: string): CloudTask['branch'] {
  const saved: unknown = JSON.parse(harnessJson)
  if (!saved || typeof saved !== 'object' || !('workspace' in saved)) return null
  const workspace = saved.workspace
  if (!workspace || typeof workspace !== 'object' || !('branch' in workspace) || typeof workspace.branch !== 'string' || !workspace.branch.trim() || !('targetBranch' in workspace) || typeof workspace.targetBranch !== 'string') return null
  return { name: workspace.branch, base: workspace.targetBranch,
    ...('baseSha' in workspace && typeof workspace.baseSha === 'string' ? { sha: workspace.baseSha } : {}) }
}
