"use client";

import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Alert, App, Button, Input, Modal } from 'antd'
import { EyeOutlined, CheckOutlined, DownloadOutlined } from '@ant-design/icons'
import type { CloudReview } from '@/contracts/cloud-agent'
import styles from './CloudAgent.module.css'
import reviewStyles from './HarnessReview.module.css'
import { ReviewDocument } from './ReviewDocument'
import { ReviewAsset, ReviewVisuals, fetchReviewAsset } from './ReviewVisuals'
import { reviewFileLabel, reviewVisualStates, reviewTitle, type ReviewFile } from './review-visuals'

type ReviewProps = { taskId: string; review: CloudReview; scrollRoot: RefObject<HTMLDivElement | null>; hideNavigation: boolean }
export function HarnessReview(props: ReviewProps) {
  return <ReviewVersion key={`${props.taskId}:${props.review.digest}`} {...props} />
}
function ReviewVersion({ taskId, review, scrollRoot, hideNavigation }: ReviewProps) {
  const { message } = App.useApp()
  const [preview, setPreview] = useState<{ url: string; mime: string; text: string; label: string } | null>(null)
  const [htmlFile, setHtmlFile] = useState<ReviewFile | null>(null)
  const [downloading, setDownloading] = useState(false)
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview])
  async function read(file: CloudReview['files'][number]) {
    if (file.label.startsWith('prototypes/')) { setHtmlFile(file); return }
    try {
      const response = await fetchReviewAsset(taskId, review.digest, file, AbortSignal.timeout(20000))
      const blob = await response.blob()
      setPreview({ url: URL.createObjectURL(blob), text: file.mime === 'text/plain' ? await blob.text() : '', mime: file.mime, label: reviewFileLabel(file) })
    } catch (error) { message.error((error as Error).message) }
  }
  async function downloadHtml() {
    if (!htmlFile) return
    setDownloading(true)
    try {
      const response = await fetchReviewAsset(taskId, review.digest, htmlFile, AbortSignal.timeout(20000))
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url; link.download = `${htmlFile.label.replaceAll('/', '-')}.html`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { message.error((error as Error).message) }
    finally { setDownloading(false) }
  }
  return <>
    <div className={reviewStyles.inline}>
      <ReviewDocument scrollRoot={scrollRoot} hideNavigation={hideNavigation} content={review.content} visuals={review.kind === 'ui' && reviewVisualStates(review.files).length ? <ReviewVisuals taskId={taskId} review={review} /> : undefined}
        attachments={review.files.length ? <details><summary>辅助资料与原始附件（{review.files.length}）</summary><ul className={reviewStyles.files}>{review.files.map(file => <li key={file.id}><Button type="link" aria-label={reviewFileLabel(file)} icon={<EyeOutlined />} onClick={() => void read(file)}>{reviewFileLabel(file)}</Button></li>)}</ul></details> : <p>当前审核无附件。</p>} />
    </div>
    <Modal title={preview?.label} open={!!preview} onCancel={() => setPreview(null)} width={900} footer={preview ? <Button icon={<DownloadOutlined />} href={preview.url} download={preview.label.replaceAll('/', '-')}>下载</Button> : null}>
      {preview?.mime.startsWith('image/') ? <img src={preview.url} alt={preview.label} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} /> : preview?.mime === 'text/plain' ? <pre className={styles.pre}>{preview.text}</pre> : <Alert type="info" message="下载文件查看完整内容" />}
    </Modal>
    <Modal title={htmlFile ? reviewFileLabel(htmlFile) : ''} open={!!htmlFile} onCancel={() => setHtmlFile(null)} width="min(1000px, calc(100vw - 24px))" destroyOnHidden footer={<Button aria-label="下载原始 HTML" icon={<DownloadOutlined />} loading={downloading} onClick={() => void downloadHtml()}>下载原始 HTML</Button>}>
      <div style={{ maxHeight: '75dvh', overflow: 'auto' }}>{htmlFile ? <ReviewAsset taskId={taskId} digest={review.digest} file={htmlFile} /> : null}</div>
    </Modal>
  </>
}

export function HarnessReviewFooter({ review, busy, canApprove, hasDraft, actions, onApprove }: { review: CloudReview; busy: boolean; canApprove: boolean; hasDraft: boolean; actions: ReactNode; onApprove: (digest: string, reason: string) => Promise<void> }) {
  const [differenceOpen, setDifferenceOpen] = useState(false)
  const [differenceReason, setDifferenceReason] = useState('')
  const acceptsDifferences = review.kind === 'visual' && review.decision === 'accepted_with_differences'
  return <><footer className={reviewStyles.footer} aria-label="审核操作">
    <div className={reviewStyles.footerMeta} title={reviewTitle(review.kind)}>{`材料 v${review.materialVersion}`}{!canApprove ? ' · 只读' : hasDraft ? ' · 有未提交修改，暂不可批准' : ' · 待确认'}</div>
    <div className={reviewStyles.footerActions}>
      <div className={styles.actionButtons}>{actions}</div>
      {canApprove ? <Button aria-label="批准当前门禁" icon={<CheckOutlined />} type="primary" loading={busy} disabled={hasDraft} onClick={async () => { if (acceptsDifferences) { setDifferenceOpen(true); return } try { await onApprove(review.digest, '') } catch { /* Keep the reviewed version on failure. */ } }}>{review.kind === 'scope' ? '确认范围，继续' : acceptsDifferences ? '审核视觉差异' : review.kind === 'visual' ? '确认效果，继续验收' : review.decision === 'not_applicable' ? '确认无 UI，开始转译' : '确认 UI，开始转译'}</Button> : null}
    </div>
  </footer>
    <Modal title="接受当前状态的视觉差异" open={differenceOpen} okText="接受差异并继续" okButtonProps={{ disabled: !differenceReason.trim(), loading: busy }} onCancel={() => setDifferenceOpen(false)} onOk={async () => { await onApprove(review.digest, differenceReason.trim()); setDifferenceOpen(false) }}>
      <Input.TextArea aria-label="具体差异及接受理由" value={differenceReason} onChange={event => setDifferenceReason(event.target.value)} rows={4} maxLength={2000} placeholder="写明当前状态与基线的具体差异，以及接受原因" />
    </Modal>
  </>
}
