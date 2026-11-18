import { memo, useMemo } from 'react'
import { CheckOutlined, ClockCircleOutlined, ExclamationCircleOutlined, LoadingOutlined } from '@ant-design/icons'
import type { CloudEvent, CloudTask } from '@/contracts/cloud-agent'
import { deviceAcceptanceProgress } from './device-progress'
import { reviewDuration } from './review-progress'
import { DeviceConclusion } from './DeviceConclusion'
import styles from './DeviceAcceptanceProgress.module.css'

export const DeviceAcceptanceProgress = memo(function DeviceAcceptanceProgress({ task, events }: { task: CloudTask; events: CloudEvent[] }) {
  const rows = useMemo(() => deviceAcceptanceProgress(task, events), [task, events])
  return <section aria-label="设备验收分项进度" className={styles.progress}>
    {task.deviceConclusion ? <DeviceConclusion conclusion={task.deviceConclusion} /> : null}
    <ol className={styles.steps}>{rows.map(row => <li key={row.id} data-status={row.status} aria-current={row.status === 'active' ? 'step' : undefined}>
      <div className={styles.heading}>
        <span className={styles.icon} aria-hidden="true">{row.status === 'passed' ? <CheckOutlined /> : row.status === 'active' ? <LoadingOutlined /> : row.status === 'attention' ? <ExclamationCircleOutlined /> : <ClockCircleOutlined />}</span>
        <strong>{row.title}</strong>
      </div>
      <span className={styles.status}>{row.label}</span>
      {row.metrics.map(metric => <span className={styles.metric} key={metric}>{metric}</span>)}
      {row.elapsedMs !== undefined ? <span className={styles.metric}>{row.timeLabel} {reviewDuration(row.elapsedMs)}</span> : null}
    </li>)}</ol>
  </section>
})
