import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Spin } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CloudRunPage } from '@/contracts/cloud-agent'
import { AttachmentList } from './MaterialAttachments'
import { request } from './client'
import styles from './CloudAgent.module.css'

export function TaskHistory({ taskId }: { taskId: string }) {
  const [data, setData] = useState<CloudRunPage>({ items: [], nextBefore: null })
  const [before, setBefore] = useState<number>()
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError('')
    // Let StrictMode's setup/cleanup probe finish before starting network work.
    const timer = setTimeout(() => {
      void request<CloudRunPage>(`/tasks/${encodeURIComponent(taskId)}/runs${before ? `?before=${before}` : ''}`, { signal: abort.signal })
      .then(page => { if (!abort.signal.aborted) setData(previous => ({ items: before ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] : page.items, nextBefore: page.nextBefore })) })
      .catch(e => { if (!abort.signal.aborted) setError(e.message) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    }, 0)
    return () => { clearTimeout(timer); abort.abort() }
  }, [taskId, before, retry])
  return <section aria-label="历史轮次记录">
    {data.items.map(run => <details className={styles.history} key={run.id}><summary>{new Date(run.createdAt).toLocaleString()} · 材料 v{run.materialVersion} · 历史只读</summary>
      <article className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{run.output || run.error || '暂无产物'}</ReactMarkdown></article>
      <details><summary>本轮材料</summary><pre className={styles.pre}>{run.materialSnapshot || '无文字快照'}</pre><AttachmentList items={run.attachments} /></details>
    </details>)}
    {error ? <Alert type="error" message={error} action={<Button icon={<ReloadOutlined />} onClick={() => setRetry(value => value + 1)}>重试</Button>} /> : null}
    {loading ? <div className={styles.historyLoading}><Spin size="small" /><span>读取历史记录</span></div> : !error && !data.items.length ? <Empty description="暂无历史记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
    {!loading && !error && data.nextBefore ? <Button onClick={() => setBefore(data.nextBefore!)}>加载更早记录</Button> : null}
  </section>
}
