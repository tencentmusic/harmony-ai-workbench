import { useEffect, useState, type RefObject } from 'react'
import { Alert, Checkbox, Empty, Tag } from 'antd'
import type { CloudEvent, CloudRun, CloudStatus } from '@/contracts/cloud-agent'
import { executionEntries, executionLabel, isExecutionError } from './execution-progress'
import styles from './CloudAgent.module.css'

const runningStatuses: CloudStatus[] = ['running', 'translating', 'reviewing', 'delivering', 'cancelling']
const duration = (seconds: number) => `${Math.floor(seconds / 60)}分${seconds % 60}秒`

export function ExecutionSummary({ events, run, status }: { events: CloudEvent[]; run?: CloudRun; status: CloudStatus }) {
  const [now, setNow] = useState(Date.now)
  const running = runningStatuses.includes(status)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!run) return null
  const entries = executionEntries(events, run.id)
  const latest = [...events].reverse().find(event => event.runId === run.id && event.message.trim())
  const step = entries.filter(event => event.kind !== 'output').at(-1)
  const explanation = entries.filter(event => event.kind === 'output').at(-1)
  const latestError = entries.filter(isExecutionError).at(-1)
  const age = Math.max(0, Math.floor((now - Date.parse(latest?.createdAt || run.createdAt)) / 1000))
  const elapsed = Math.max(0, Math.floor(((running ? now : Date.parse(run.finishedAt || run.createdAt)) - Date.parse(run.createdAt)) / 1000))
  return <section aria-label="本轮执行概况" className={styles.executionSummary}>
    <div className={styles.meta}>{running ? <Tag color="processing">本轮执行中</Tag> : null}<span>耗时 {duration(elapsed)}</span><span>{latest ? `最近活动 ${new Date(latest.createdAt).toLocaleTimeString()}` : '尚未收到本轮事件'}{running ? ` · ${duration(age)}未更新` : ''}</span></div>
    {running ? <p>{step ? executionLabel(step.message) : '等待执行进展'}</p> : null}
    {running && explanation ? <p className={styles.executionExcerpt}>{explanation.message.slice(-240)}</p> : null}
    {running && age >= 60 ? <Alert type="warning" showIcon message="暂未收到新事件" description="可能仍在等待模型或工具返回，尚不能据此判断卡死。" /> : null}
    {latestError ? <details><summary>本轮最近异常 · {new Date(latestError.createdAt).toLocaleTimeString()}</summary><p>{latestError.message}</p></details> : null}
  </section>
}

export function ExecutionTimeline({ events, run, scrollRoot }: { events: CloudEvent[]; run?: CloudRun; scrollRoot: RefObject<HTMLDivElement | null> }) {
  const [follow, setFollow] = useState(true)
  const entries = executionEntries(events, run?.id)
  const last = entries.at(-1)
  useEffect(() => {
    if (follow && scrollRoot.current) scrollRoot.current.scrollTop = scrollRoot.current.scrollHeight
  }, [follow, last?.id, last?.message, scrollRoot])
  return <section aria-label="本轮实时过程">
    <div className={styles.meta}><span>本轮记录 · 最多保留最近 500 条事件</span><Checkbox checked={follow} onChange={event => setFollow(event.target.checked)}>跟随最新</Checkbox></div>
    <div className={styles.executionViewport}>
      {entries.length ? <ol className={styles.executionEvents}>{entries.map(event => <li key={event.id} data-error={isExecutionError(event)}><div className={styles.meta}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span>{event.kind === 'output' ? '执行说明' : isExecutionError(event) ? '执行异常' : '执行事件'}</span></div><pre className={styles.pre}>{executionLabel(event.message)}</pre></li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未收到本轮过程事件" />}
    </div>
    {!entries.length && run?.output ? <details><summary>本轮已保存的输出</summary><pre className={styles.pre}>{run.output}</pre></details> : null}
  </section>
}
