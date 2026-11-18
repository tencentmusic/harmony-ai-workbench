import { AuditOutlined, BookOutlined, CheckCircleOutlined, CodeOutlined, FileSearchOutlined, FileTextOutlined, ForkOutlined, MobileOutlined, SafetyCertificateOutlined, ToolOutlined, PartitionOutlined } from '@ant-design/icons'
import { CLOUD_STAGES, type CloudStageId, type CloudSummary } from '@/contracts/cloud-agent'
import styles from './CloudAgent.module.css'

const icons = [FileTextOutlined, FileSearchOutlined, AuditOutlined, CheckCircleOutlined, CodeOutlined, SafetyCertificateOutlined, ToolOutlined, MobileOutlined, ForkOutlined, BookOutlined]

export function LifecycleOverview({ summary, selected, onSelect }: { summary: CloudSummary | null; selected?: CloudStageId; onSelect: (stage: CloudStageId) => void }) {
  return <section className={styles.lifecycle} aria-labelledby="cloud-lifecycle-heading">
    <header className={styles.lifecycleHeader}>
      <h2 id="cloud-lifecycle-heading"><PartitionOutlined />全生命周期阶段分布</h2>
    </header>
    <div className={styles.lifecycleScroll}>
      <ol className={styles.lifecycleTrack}>
        {CLOUD_STAGES.map((stage, index) => {
          const Icon = icons[index]
          const count = summary?.byStage[stage.id] ?? 0
          const blocked = summary?.issuesByStage?.[stage.id] || 0
          return <li key={stage.id} className={stage.enabled ? styles.stageAvailable : styles.stagePending}>
            <button type="button" disabled={!summary} aria-pressed={selected === stage.id} title={stage.enabled ? undefined : '自动执行待接入'}
              aria-label={`${stage.label}，${stage.enabled ? summary ? `${count} 项` : '加载中' : '待接入'}`}
              className={`${styles.stageNode} ${selected === stage.id ? styles.stageActive : ''}`} onClick={() => onSelect(stage.id)}>
              <span className={styles.stageIcon}><Icon /></span>
              <span className={styles.stageName}>{stage.label}</span>
              <span className={stage.enabled ? styles.stageCount : styles.pendingBadge}>{stage.enabled ? summary ? `${count} 项` : '--' : `${count} 项 · 待接入`}</span>
              <span className={styles.stageIssue}>{blocked ? `${blocked} 项异常` : ''}</span>
            </button>
          </li>
        })}
      </ol>
    </div>
  </section>
}
