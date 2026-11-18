"use client";

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Segmented, Spin, Tooltip } from 'antd'
import { ExpandOutlined, ReloadOutlined } from '@ant-design/icons'
import type { CloudReview } from '@/contracts/cloud-agent'
import { reviewVisualStates, type ReviewFile } from './review-visuals'
import styles from './ReviewVisuals.module.css'

type Preview = { html: string; title: string; width: number; height: number; warnings: string[] }
type AssetProps = { taskId: string; digest: string; file: ReviewFile; originalSize?: boolean; fitPage?: boolean }
const stateNames: Record<string, string> = { static: '静态封面', motion: '视频播放态', scrolled: '滚动后', loading: '加载中', empty: '空状态', error: '异常状态', ready: '就绪状态' }

export async function fetchReviewAsset(taskId: string, digest: string, file: ReviewFile, signal: AbortSignal, html = false) {
  const query = new URLSearchParams({ digest, file: file.id })
  if (html) query.set('preview', 'html')
  const response = await fetch(`/api/cloud-agent/tasks/${taskId}/review-file?${query}`, { headers: { authorization: `Bearer ${localStorage.getItem('hm_token') || ''}` }, signal, cache: 'no-store' })
  if (!response.ok) throw new Error((await response.json()).error || '审核文件读取失败')
  return response
}

export function ReviewAsset({ taskId, digest, file, originalSize = false, fitPage = false }: AssetProps) {
  const html = file.label.startsWith('prototypes/')
  const [data, setData] = useState<{ url?: string; preview?: Preview } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let url = ''
    setData(null); setError('')
    void (async () => {
      try {
        const response = await fetchReviewAsset(taskId, digest, file, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), html)
        if (html) {
          const value: unknown = await response.json()
          if (!value || typeof value !== 'object' || !('html' in value) || typeof value.html !== 'string' || !('width' in value) || typeof value.width !== 'number' || !('height' in value) || typeof value.height !== 'number' || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0 || !('title' in value) || typeof value.title !== 'string' || !('warnings' in value) || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string')) throw new Error('原型预览格式无效')
          if (!controller.signal.aborted) setData({ preview: value as Preview })
        } else {
          const blob = await response.blob()
          if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setData({ url }) }
        }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '预览失败') }
    })()
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [taskId, digest, file.id, html, attempt])
  if (error) return <Alert type="error" showIcon message={error} action={<Button icon={<ReloadOutlined />} onClick={() => setAttempt(value => value + 1)}>重试</Button>} />
  if (!data) return <div className={styles.loading}><Spin /></div>
  return <>
    {data.preview ? <>
      {data.preview.warnings.length ? <Alert className={styles.warning} type="warning" showIcon message={data.preview.warnings.join(' ')} /> : null}
      <HtmlCanvas preview={data.preview} originalSize={originalSize} fitPage={fitPage} />
    </> : <img className={originalSize ? styles.originalImage : styles.image} style={fitPage ? { maxHeight: 'calc(100dvh - 210px)', width: 'auto', maxWidth: '100%', objectFit: 'contain' } : undefined} src={data.url} alt={file.label.startsWith('baselines/') ? 'Android 基线截图' : '原型渲染图'} onError={() => setError('图片解码失败，请检查审核材料')} />}
  </>
}

function HtmlCanvas({ preview, originalSize, fitPage }: { preview: Preview; originalSize: boolean; fitPage: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const [availableHeight, setAvailableHeight] = useState(0)
  useEffect(() => {
    if (!root.current) return
    const updateHeight = () => setAvailableHeight(Math.max(200, window.innerHeight - 210))
    const observer = new ResizeObserver(entries => { setAvailable(entries[0].contentRect.width); updateHeight() })
    observer.observe(root.current)
    window.addEventListener('resize', updateHeight)
    return () => { observer.disconnect(); window.removeEventListener('resize', updateHeight) }
  }, [])
  const scale = originalSize ? 1 : Math.min(1, (available || preview.width) / preview.width, fitPage ? (availableHeight || preview.height) / preview.height : 1)
  return <div className={styles.canvas} ref={root}>
    <div className={styles.canvasSize} style={{ width: preview.width * scale, height: preview.height * scale }}>
      <iframe title={`HTML 原型 · ${preview.title || '页面预览'}`} sandbox="" referrerPolicy="no-referrer" srcDoc={preview.html}
        style={{ width: preview.width, height: preview.height, transform: `scale(${scale})` }} />
    </div>
  </div>
}

export function ReviewVisuals({ taskId, review }: { taskId: string; review: CloudReview }) {
  const states = reviewVisualStates(review.files)
  const [selected, setSelected] = useState(states[0]?.id)
  const [expanded, setExpanded] = useState<{ file: ReviewFile; title: string } | null>(null)
  const [zoom, setZoom] = useState('page')
  const state = states.find(item => item.id === selected) || states[0]
  if (!state) return null
  const prototype = state.render
  function expand(file: ReviewFile, title: string) { setZoom('page'); setExpanded({ file, title }) }
  return <div className={styles.root}>
    <div className={styles.stateBar} role="tablist" aria-label="UI 页面状态">
      {states.map((item, index) => <Tooltip key={item.id} title={item.id}><button type="button" role="tab" aria-selected={state.id === item.id} onClick={() => setSelected(item.id)}>
        <span>{String(index + 1).padStart(2, '0')}</span>{stateNames[item.id.split('_').at(-1)!] || item.id}
      </button></Tooltip>)}
    </div>
    <div className={styles.comparison}>
      <div className={styles.column}>
        <header><strong>Android 基线</strong>{state.baseline ? <Tooltip title="放大 Android 基线"><Button size="small" icon={<ExpandOutlined />} aria-label="放大 Android 基线" onClick={() => expand(state.baseline!, 'Android 基线')} /></Tooltip> : null}</header>
        <div className={styles.surface}>{state.baseline ? <ReviewAsset key={state.baseline.id} taskId={taskId} digest={review.digest} file={state.baseline} /> : <Alert type="warning" message="缺少 Android 基线" />}</div>
      </div>
      <div className={styles.column}>
        <header><strong>Harmony 原型</strong><div className={styles.tools}>
          {prototype ? <Tooltip title="放大原型"><Button size="small" icon={<ExpandOutlined />} aria-label="放大原型" onClick={() => expand(prototype, '原型渲染图')} /></Tooltip> : null}
        </div></header>
        <div className={styles.surface}>{prototype ? <ReviewAsset key={prototype.id} taskId={taskId} digest={review.digest} file={prototype} /> : <Alert type="warning" message="缺少原型渲染图" />}</div>
      </div>
    </div>
    <Modal title={`${expanded?.title || ''} · ${state.id}`} open={!!expanded} onCancel={() => setExpanded(null)} width="min(1180px, calc(100vw - 24px))" style={{ top: 20 }} destroyOnHidden footer={null}>
      <div className={styles.zoomBar}><Segmented value={zoom} onChange={setZoom} options={[{ label: '完整页面', value: 'page' }, { label: '适配宽度', value: 'fit' }, { label: '原始尺寸', value: 'original' }]} /></div>
      <div className={styles.expanded}>{expanded ? <ReviewAsset key={expanded.file.id} taskId={taskId} digest={review.digest} file={expanded.file} originalSize={zoom === 'original'} fitPage={zoom === 'page'} /> : null}</div>
    </Modal>
  </div>
}
