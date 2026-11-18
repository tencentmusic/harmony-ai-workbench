import type { CloudTask } from '@/contracts/cloud-agent'

export function handoffLabel(task: CloudTask) {
  const status = task.delivery?.handoff?.status
  return status === 'pending' ? '待开发本地复核' : status === 'closed' ? '提测记录已关闭' : status === 'missing' ? '提测记录待核对'
    : task.delivery?.codeMerged ? '已提测 · 代码已合入' : status === 'submitted' ? '已提测 · 等待 MR 合入' : '交付准备中'
}
