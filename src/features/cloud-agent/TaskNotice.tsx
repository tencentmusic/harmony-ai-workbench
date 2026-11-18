import { Alert } from 'antd'
import type { TaskNoticeValue } from './task-notice'
import styles from './CloudAgent.module.css'

export function TaskNotice({ value }: { value: TaskNoticeValue | null }) {
  if (!value) return null
  return <Alert className={styles.taskNotice} aria-label="任务状态提示" type={value.type} showIcon message={value.title} description={<>
    <p className={styles.noticeReason}>{value.reason}</p>
    <p className={styles.noticeNext}><strong>下一步：</strong>{value.next}</p>
    {value.details && value.details !== value.reason ? <details className={styles.noticeDetails}>
      <summary>技术详情</summary><pre>{value.details}</pre>
    </details> : null}
  </>} />
}
