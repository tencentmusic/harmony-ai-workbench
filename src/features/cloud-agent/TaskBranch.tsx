import { BranchesOutlined } from '@ant-design/icons'
import type { CloudTask } from '@/contracts/cloud-agent'
import styles from './CloudAgent.module.css'

export function TaskBranch({ task, showSha = false }: { task: CloudTask; showSha?: boolean }) {
  return <span className={styles.branchInfo}>
    <span className={styles.branchName}><BranchesOutlined /><span>{task.branch ? task.branch.name : '特性分支待创建'}</span></span>
    <span className={styles.branchBase}>{task.branch ? `基于 ${task.branch.base} 创建` : `计划基于 ${task.targetBranch} 创建`}{showSha && task.branch?.sha ? <code title={task.branch.sha}>基线 {task.branch.sha.slice(0, 12)}</code> : null}</span>
  </span>
}
