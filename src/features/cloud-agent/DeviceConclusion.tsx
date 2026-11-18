import { CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import type { CloudDeviceConclusion } from '@/contracts/cloud-agent'
import { conclusionItems } from './device-conclusion-presentation'
import styles from './DeviceConclusion.module.css'

const nodeStatus = { passed: '通过', blocked: '待解决', pending: '未完成' } as const

export function DeviceConclusion({ conclusion }: { conclusion: CloudDeviceConclusion }) {
  const passed = conclusion.result === 'passed'
  const items = conclusionItems(conclusion.reason)
  const blockers = conclusion.blockers.filter((item, index, all) => all.findIndex(other => other.code === item.code && other.message === item.message) === index)
  return <section className={styles.conclusion} aria-label="设备验收结论">
    <header className={styles.header}>
      <h3>设备验收结论</h3>
      <span className={styles.result} data-passed={passed}>
        {passed ? <CheckCircleOutlined aria-hidden="true" /> : <ExclamationCircleOutlined aria-hidden="true" />}
        {passed ? '通过' : '未完成'}
      </span>
    </header>
    {conclusion.nodes.length ? <dl className={styles.states} aria-label="验收分项结果">
      {conclusion.nodes.map(node => <div key={node.id}>
        <dt>{node.label}</dt><dd data-status={node.status}>{nodeStatus[node.status]}</dd>
      </div>)}
    </dl> : null}
    <h4>结论与待办</h4>
    {items.length ? <ol className={styles.records}>{items.slice(0, 4).map(item => <li key={item}>{item}</li>)}</ol> : <p className={styles.empty}>暂无结论说明</p>}
    {items.length > 4 ? <details className={styles.details}>
      <summary>其余结论与待办 · {items.length - 4} 条</summary>
      <ol className={styles.records} start={5}>{items.slice(4).map(item => <li key={item}>{item}</li>)}</ol>
    </details> : null}
    {blockers.length ? <details className={styles.details}>
      <summary>门禁记录 · {blockers.length} 项</summary>
      <ul className={styles.records}>{blockers.map(item => <li key={`${item.code}:${item.message}`}><code>{item.code}</code><p>{item.message}</p></li>)}</ul>
    </details> : null}
    <details className={styles.details}>
      <summary>证据版本与原始记录</summary>
      <dl className={styles.metadata}>
        <dt>材料版本</dt><dd>{conclusion.materialVersion}</dd>
        <dt>结论时间</dt><dd>{conclusion.concludedAt}</dd>
        <dt>源码 HEAD</dt><dd><code>{conclusion.sourceHeadSha}</code></dd>
        <dt>HAP SHA256</dt><dd><code>{conclusion.hapSha256 || '未登记'}</code></dd>
        <dt>报告 SHA256</dt><dd><code>{conclusion.verificationSha256}</code></dd>
      </dl>
      <h4>原始结论</h4><pre className={styles.raw}>{conclusion.reason || '未提供'}</pre>
      {conclusion.blockers.length ? <><h4>原始门禁记录</h4><pre className={styles.raw}>{JSON.stringify(conclusion.blockers, null, 2)}</pre></> : null}
    </details>
  </section>
}
