"use client";

import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Modal, Progress, Tooltip } from 'antd'
import { CloseOutlined, DownloadOutlined, EyeOutlined, FileTextOutlined, PictureOutlined, ReloadOutlined, UploadOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { CLOUD_MATERIAL_ACCEPT, CLOUD_MATERIAL_COUNT, CLOUD_MATERIAL_TOTAL, type CloudAttachment } from '@/contracts/cloud-agent'
import styles from './MaterialAttachments.module.css'

const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
const icon = (kind: CloudAttachment['kind']) => kind === 'image' ? <PictureOutlined /> : kind === 'video' ? <VideoCameraOutlined /> : <FileTextOutlined />

export function AttachmentList({ items, onRemove, disabled }: { items: CloudAttachment[]; onRemove?: (id: string) => void; disabled?: boolean }) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState('')
  const [preview, setPreview] = useState<{ url: string; item: CloudAttachment } | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  async function load(item: CloudAttachment, show: boolean) {
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    setLoading(item.id)
    try {
      const response = await fetch(`/api/cloud-agent/attachments/${item.id}`, { headers: { authorization: `Bearer ${localStorage.getItem('hm_token') || ''}` }, signal: abort.signal, cache: 'no-store' })
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || '附件读取失败') }
      const blob = await response.blob()
      if (abort.signal.aborted) return
      const url = URL.createObjectURL(blob)
      if (show) { setPreviewError(false); setPreview({ url, item }) }
      else { const link = document.createElement('a'); link.href = url; link.download = item.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
    } catch (error) { if (!abort.signal.aborted) message.error((error as Error).message) }
    finally { if (!abort.signal.aborted) setLoading('') }
  }
  return <>
    <ul className={styles.list}>{items.map(item => <li key={item.id} className={styles.file}>
      <span className={styles.icon}>{icon(item.kind)}</span><div className={styles.info}><strong title={item.name}>{item.name}</strong><small>{sizeLabel(item.size)}{item.kind === 'video' ? ' · 抽帧分析，无音频转写' : ''}</small></div>
      <div className={styles.controls}>
        {item.kind !== 'document' ? <Button title="预览" aria-label={`预览 ${item.name}`} size="small" type="text" icon={<EyeOutlined />} loading={loading === item.id} onClick={() => void load(item, true)} /> : null}
        <Button title="下载原文件" aria-label={`下载 ${item.name}`} size="small" type="text" icon={<DownloadOutlined />} loading={loading === item.id} onClick={() => void load(item, false)} />
        {onRemove ? <Button title="从本版材料移除" aria-label={`移除 ${item.name}`} disabled={disabled} size="small" type="text" icon={<CloseOutlined />} onClick={() => onRemove(item.id)} /> : null}
      </div>
    </li>)}</ul>
    <Modal title={preview?.item.name} open={!!preview} footer={null} width={900} onCancel={() => setPreview(null)} destroyOnHidden>
      {previewError ? <Alert type="warning" showIcon message="浏览器无法预览此文件，请下载原文件查看" action={preview ? <Button icon={<DownloadOutlined />} onClick={() => void load(preview.item, false)}>下载</Button> : null} /> : null}
      {preview?.item.kind === 'image' ? <img className={styles.preview} src={preview.url} alt={preview.item.name} onError={() => setPreviewError(true)} /> : preview ? <video className={styles.preview} src={preview.url} controls playsInline preload="metadata" onError={() => setPreviewError(true)} /> : null}
    </Modal>
  </>
}

export function MaterialAttachments({ appId, items, onChange, onBusyChange, disabled = false }: {
  appId: string; items: CloudAttachment[]; onChange: (items: CloudAttachment[]) => void; onBusyChange: (busy: boolean) => void; disabled?: boolean
}) {
  const { message } = App.useApp()
  const [pending, setPending] = useState<{ file: File; error?: string; progress: number }[]>([])
  const [uploading, setUploading] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const current = useRef(items); current.current = items
  const request = useRef<XMLHttpRequest | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])
  async function upload(files: File[]) {
    if (uploading || !files.length) return
    if (current.current.length + files.length > CLOUD_MATERIAL_COUNT || current.current.reduce((sum, item) => sum + item.size, 0) + files.reduce((sum, item) => sum + item.size, 0) > CLOUD_MATERIAL_TOTAL) { message.error('每个任务最多 10 个附件，合计不超过 200 MB'); return }
    setUploading(true); onBusyChange(true)
    const queue = files.map(file => ({ file, progress: 0, error: undefined as string | undefined }))
    setPending([...queue])
    for (const row of [...queue]) {
      if (!mounted.current) return
      try {
        const extension = `.${row.file.name.split('.').at(-1)?.toLowerCase()}`
        if (!CLOUD_MATERIAL_ACCEPT.split(',').includes(extension)) throw new Error('不支持此格式')
        if (row.file.size > (/\.(mp4|mov|webm)$/i.test(row.file.name) ? 100 : 10) * 1024 * 1024 || row.file.size === 0) throw new Error('文件为空或超过大小限制')
        const item = await new Promise<CloudAttachment>((resolve, reject) => {
          const xhr = new XMLHttpRequest(); request.current = xhr
          xhr.open('POST', `/api/cloud-agent/attachments?${new URLSearchParams({ appId, name: row.file.name })}`)
          xhr.setRequestHeader('authorization', `Bearer ${localStorage.getItem('hm_token') || ''}`)
          xhr.timeout = 190000
          xhr.upload.onprogress = event => { row.progress = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0; if (mounted.current) setPending([...queue]) }
          xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300) resolve(data.item); else reject(new Error(data.error || '上传失败')) } catch { reject(new Error('上传失败，请检查服务状态')) } }
          xhr.onerror = () => reject(new Error('网络错误，请重试'))
          xhr.ontimeout = () => reject(new Error('上传超时，请重试'))
          xhr.onabort = () => reject(new Error('上传已取消'))
          xhr.send(row.file)
        })
        if (!mounted.current) return
        current.current = [...current.current, item]; onChange(current.current)
        queue.splice(queue.indexOf(row), 1)
      } catch (error) { row.error = (error as Error).message }
      if (mounted.current) setPending([...queue])
    }
    if (mounted.current) { setUploading(false); onBusyChange(queue.length > 0) }
  }
  return <div className={styles.root}>
    <div className={styles.toolbar}><Button icon={<UploadOutlined />} disabled={disabled || uploading || !!pending.length || !appId || items.length >= 10} onClick={() => picker.current?.click()}>添加附件</Button><span>{items.length} / 10</span></div>
    <input aria-label="上传需求附件" ref={picker} type="file" accept={CLOUD_MATERIAL_ACCEPT} multiple hidden onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void upload(files) }} />
    <div className={styles.limits}>文档、图片 ≤ 10 MB；视频 ≤ 100 MB / 10 分钟</div>
    <AttachmentList items={items} disabled={disabled || uploading} onRemove={id => { current.current = current.current.filter(item => item.id !== id); onChange(current.current) }} />
    <ul className={styles.list}>{pending.map((row, index) => <li className={styles.file} key={`${row.file.name}-${index}`}>
      <span className={styles.icon}><UploadOutlined /></span><div className={styles.info}><strong>{row.file.name}</strong>{row.error ? <small className={styles.error}>{row.error}</small> : <><Progress percent={row.progress} size="small" /><small>{row.progress === 100 ? '正在校验材料' : '上传中'}</small></>}</div>
      {!uploading ? <div className={styles.controls}><Tooltip title="重试"><Button aria-label={`重试 ${row.file.name}`} type="text" icon={<ReloadOutlined />} onClick={() => void upload(pending.map(item => item.file))} /></Tooltip><Tooltip title="移除"><Button aria-label={`移除失败附件 ${row.file.name}`} type="text" icon={<CloseOutlined />} onClick={() => { const rest = pending.filter(item => item !== row); setPending(rest); onBusyChange(rest.length > 0) }} /></Tooltip></div> : null}
    </li>)}</ul>
  </div>
}
