"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Empty, Segmented, Tag, Tooltip } from 'antd'
import { CheckOutlined, ExclamationOutlined, ExpandOutlined, CompressOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CloudTask, CloudEvent } from '@/contracts/cloud-agent'
import { AttachmentList } from './MaterialAttachments'
import { HarnessReview, HarnessReviewFooter } from './HarnessReview'
import { reviewTitle } from './review-visuals'
import { approvalOptions, selectedApproval, isPendingReview } from './review-selection'
import { ReviewDocument } from './ReviewDocument'
import { ExecutionTimeline } from './ExecutionProgress'
import { TaskHistory } from './TaskHistory'
import { RuntimeDetails, VisualReportViewer } from './RuntimeDetails'
import { CodeReviewProgress } from './CodeReviewProgress'
import { DeviceAcceptanceProgress } from './DeviceAcceptanceProgress'
import { DeliveryHandoff, DeliveryHandoffFooter } from './DeliveryHandoff'
import { currentTaskNode, taskWorkflow, taskRepair, TASK_NODES, NODE_STATUS, type TaskNodeId } from './task-workflow'
import styles from './CloudAgent.module.css'

const markdown = { img: () => null, a: ({ children }: { children?: ReactNode }) => <span>{children}</span> }
const STAGE_BRIEF: Record<TaskNodeId, string> = {
  material: '核对业务目标和附件，确认后进入需求分析',
  analysis: '看需求范围和源码依据是否对齐',
  approval: '确认范围和界面原型后再进入转译',
  coding: '查看本轮转译改了哪些代码',
  review: '看审查结论和还要处理的问题',
  build: '看构建是否通过，以及失败原因',
  device: '看真机验收结果和对照画面',
  integration: '核对提测材料和本地复核结论',
  knowledge: '看知识文档是否已经回流',
}
const MATERIAL_MARKERS = [
  { label: '用户描述', pattern: /#{0,3}\s*用户描述需求要点\s*[：:]?/ },
  { label: '用户补充', pattern: /#{0,3}\s*用户补充(?:（[^）\n]*）|\([^)\n]*\))?/ },
  { label: '用户描述', pattern: /用户描述\s*[：:]/ },
  { label: '已确认', pattern: /已确认\s*[：:]/ },
  { label: '需关注', pattern: /需关注\s*[：:]/ },
]
function materialBlocks(material: string) {
  const text = material.trim()
  if (!text) return []
  const hits: { index: number; end: number; label: string }[] = []
  for (const marker of MATERIAL_MARKERS) {
    const re = new RegExp(`(?:^|\\n)${marker.pattern.source}`, 'g')
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const raw = match[0].replace(/^\n/, '').replace(/^#+\s*/, '').replace(/[：:]\s*$/, '').trim()
      hits.push({ index: match.index + (match[0].startsWith('\n') ? 1 : 0), end: match.index + match[0].length, label: marker.label === '用户补充' ? raw || marker.label : marker.label })
    }
  }
  hits.sort((left, right) => left.index - right.index || right.end - left.end)
  const markers = hits.reduce<{ index: number; end: number; label: string }[]>((kept, hit) => {
    const last = kept[kept.length - 1]
    if (!last || hit.index >= last.end) kept.push(hit)
    return kept
  }, [])
  if (!markers.length) return [{ label: '需求说明', text }]
  const blocks: { label: string; text: string }[] = []
  const lead = text.slice(0, markers[0].index).trim()
  if (lead) blocks.push({ label: '需求说明', text: lead })
  markers.forEach((hit, index) => {
    const body = text.slice(hit.end, markers[index + 1]?.index ?? text.length).replace(/^[：:\s]+/, '').trim()
    if (body) blocks.push({ label: hit.label, text: body })
  })
  return blocks.length ? blocks : [{ label: '需求说明', text }]
}
function reviewParagraphs(summary: string) {
  const text = summary.trim()
  if (!text) return []
  return text.split(/\n{2,}/).flatMap(part => part.trim().split(/(?<=[。；])\s*(?=\d+[.、．]\s*)/)).map(item => item.trim()).filter(Boolean)
}
export function TaskWorkspace({ task, events, busy, hasDraft, actions, materialAction, onApprove, onConfirmDelivery, summary, expanded, onToggleExpanded, onBack }: {
  task: CloudTask; events: CloudEvent[]; busy: boolean; hasDraft: boolean; actions: ReactNode; materialAction: ReactNode; onApprove: (digest: string, reason: string) => Promise<void>;
  summary: ReactNode; expanded: boolean; onToggleExpanded: () => void; onBack: () => void
  onConfirmDelivery: (reason: string) => Promise<void>
}) {
  const [selected, setSelected] = useState<TaskNodeId | null>(null)
  const [panel, setPanel] = useState<'node' | 'execution' | 'history'>('node')
  const [viewedDigest, setViewedDigest] = useState(task.review?.digest)
  const [reviewSelection, setReviewSelection] = useState<{ pendingDigest?: string; kind: 'scope' | 'ui' } | null>(null)
  const current = currentTaskNode(task), active = selected || current
  const nodes = taskWorkflow(task), stage = nodes.find(item => item.id === active)!
  const repair = taskRepair(task)
  const native = task.harness?.nodes.filter(node => (stage.phases as readonly string[]).includes(node.id)) || []
  const reviewNode = task.review?.kind === 'visual' ? 'device' : 'approval'
  const options = approvalOptions(task)
  const review = active === 'approval' ? selectedApproval(task, reviewSelection?.pendingDigest === task.review?.digest ? reviewSelection?.kind : undefined) : task.review && active === reviewNode ? task.review : null
  const scrollRoot = useRef<HTMLDivElement>(null)
  const flowRoot = useRef<HTMLElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const positionKey = `${panel}:${active}:${task.materialVersion}:${review?.digest || ''}`
  useLayoutEffect(() => {
    const root = flowRoot.current
    if (!root) return
    const alignCurrent = () => {
      const node = root.querySelector<HTMLElement>(`[data-node="${current}"]`)
      if (node) root.scrollTo({ left: root.scrollLeft + node.getBoundingClientRect().left - root.getBoundingClientRect().left - (root.clientWidth - node.clientWidth) / 2, behavior: 'instant' })
    }
    const observer = new ResizeObserver(alignCurrent)
    observer.observe(root); alignCurrent()
    return () => observer.disconnect()
  }, [current])
  useLayoutEffect(() => {
    const root = scrollRoot.current, bar = toolbar.current
    if (!root || !bar) return
    const measure = () => {
      root.style.setProperty('--task-toolbar-height', `${bar.offsetHeight}px`)
      root.style.setProperty('--task-scroll-height', `${root.clientHeight}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root); observer.observe(bar); measure()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    scrollRoot.current?.scrollTo({ top: positions.current.get(positionKey) || 0, behavior: 'instant' })
  }, [positionKey])
  useEffect(() => { if (task.review?.digest) setViewedDigest(previous => previous ?? task.review!.digest) }, [task.review?.digest])
  const pendingReview = !!review && isPendingReview(task, review)
  const reviewChanged = pendingReview && viewedDigest !== undefined && review!.digest !== viewedDigest
  const canApprove = pendingReview && !reviewChanged
  const currentActions = panel !== 'node' ? null : active === current ? actions : active === 'material' ? materialAction : null
  let body: ReactNode
  if (panel === 'execution') body = <ExecutionTimeline events={events} run={task.runs[0]} scrollRoot={scrollRoot} />
  else if (panel === 'history') body = <TaskHistory key={task.id} taskId={task.id} />
  else if (active === 'material') {
    const blocks = materialBlocks(task.material)
    body = <div className={styles.stageSheet}>
      {blocks.length ? blocks.map((block, index) => <section className={styles.stageBlock} key={`${block.label}-${index}`}><h3>{block.label}</h3><p>{block.text}</p></section>) : <section className={styles.stageBlock}><h3>需求说明</h3><p className={styles.stageBlockEmpty}>未填写文字材料</p></section>}
      <section className={styles.stageBlock} aria-label="附件">
        <h3>附件</h3>
        {task.attachments.length ? <AttachmentList items={task.attachments} /> : <p className={styles.stageBlockEmpty}>没有附件</p>}
      </section>
    </div>
  }
  else if (review) body = <HarnessReview taskId={task.id} review={review} scrollRoot={scrollRoot} hideNavigation={expanded} />
  else if (active === 'analysis' || active === 'approval') body = task.harness?.reviewPackage ? <ReviewDocument scrollRoot={scrollRoot} hideNavigation={expanded} content={task.harness.reviewPackage} attachments={<AttachmentList items={task.attachments} />} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无当前环节产物" />
  else if (active === 'review') {
    const report = task.harness?.codeReview
    const paragraphs = reviewParagraphs(report?.summary || '')
    body = report ? <div className={styles.stageSheet} aria-label="代码审查报告">
      <section className={styles.stageBlock}><CodeReviewProgress report={report} run={task.runs[0]} executing={task.status === 'translating'} stale={stage.status === 'stale' || stage.status === 'recheck'} /></section>
      <section className={styles.stageBlock}><h3>审查结论</h3>{paragraphs.length ? paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className={styles.stageBlockEmpty}>尚无审查结论</p>}</section>
      {report.checks.length ? <section className={styles.stageBlock}><h3>检查项</h3><ul className={styles.stageList}>{report.checks.map(check => <li key={check.id}>{{ passed: '通过', failed: '失败', blocked: '待查证' }[check.status]} · {check.evidence}</li>)}</ul></section> : null}
      {report.findings.length ? <section className={styles.stageBlock}><h3>待处理</h3><ul className={styles.stageList}>{report.findings.map((finding, index) => <li key={finding.issueId || index}><Tag>{finding.severity}</Tag><code>{finding.issueId ? `${finding.issueId} · ` : ''}{finding.path}:{finding.line}</code> {finding.message}</li>)}</ul></section> : null}
    </div> : stage.status === 'recheck' ? <Alert type="info" showIcon message="上一版本已通过，当前改动待复核" description="本轮审查报告尚未生成，过往记录保留在执行过程与历史轮次中。" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无独立审查报告" />
  } else if (active === 'integration') body = <DeliveryHandoff task={task} />
  else if (active === 'knowledge') body = <div className={styles.markdown}>
    <p>{task.deviceConclusion?.result === 'incomplete' ? '设备验收未完成，严格交付文档尚未形成；本次不自动回流知识。' : task.status === 'completed' ? '知识文档已核实合入' : task.delivery?.codeMerged ? '代码已合入，等待知识文档回流' : '等待特性分支 MR 合入目标分支后自动回流知识'}</p>
    {task.delivery?.knowledgeUrl ? <a href={task.delivery.knowledgeUrl} target="_blank" rel="noopener noreferrer">查看知识回流 MR</a> : null}
  </div>
  else body = <>
    {stage.status === 'recheck' ? <Alert type="info" showIcon message="上一版本已通过，当前改动待复核" /> : null}
    <section className={styles.stageBlock} aria-label="本环节证据">
      <h3>本环节证据</h3>
      {native.length ? <ul className={styles.stageEvidence}>{native.map(node => <li key={node.id}><span>{node.label}</span><Tag color={stage.status === 'stale' ? 'default' : node.status === 'passed' ? 'green' : node.status === 'blocked' ? 'orange' : 'default'}>{stage.status === 'stale' ? '待更新' : node.status === 'passed' ? '已通过' : node.status === 'blocked' ? '待解决' : '未完成'}</Tag></li>)}</ul> : <p className={styles.stageBlockEmpty}>尚无当前环节证据</p>}
    </section>
    {active === current && task.harness?.blockers.length ? repair ? <details className={styles.history}><summary>本轮待校验条件 · {task.harness.blockers.length} 项</summary><ul>{task.harness.blockers.map((item, index) => <li key={index}>{item.message}</li>)}</ul></details> : <Alert type="warning" message="当前待处理" description={<ul>{task.harness.blockers.map((item, index) => <li key={index}>{item.message}</li>)}</ul>} /> : null}
    {task.runs[0]?.kind === 'translation' && task.runs[0].output ? <details className={styles.history}><summary>本轮转译记录</summary><article className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>{task.runs[0].output.split('## 本轮执行记录\n\n').slice(-1)[0]}</ReactMarkdown></article></details> : null}
  </>
  return <section className={styles.taskWorkspace} aria-label={panel === 'node' && review ? reviewTitle(review.kind) : '任务详情'}>
    <div ref={scrollRoot} className={styles.detailScroll} aria-label="任务详情滚动区" onScroll={event => positions.current.set(positionKey, event.currentTarget.scrollTop)}>
    {summary}
    <nav ref={flowRoot} className={styles.taskFlow} aria-label="当前任务流程">
      {nodes.map((node, index) => <button type="button" key={node.id} data-node={node.id} aria-current={panel === 'node' && active === node.id ? 'step' : undefined} data-status={node.status} data-connected={node.status === 'passed' && ['passed', 'current', 'waiting', 'blocked', 'recheck'].includes(nodes[index + 1]?.status)} onClick={() => { setSelected(node.id === current ? null : node.id); setPanel('node') }}>
        <span className={styles.flowIcon} aria-hidden="true">{node.status === 'passed' ? <CheckOutlined /> : node.status === 'blocked' || node.status === 'recheck' ? <ExclamationOutlined /> : null}</span><span className={styles.flowLabel}>{node.label}</span><small>{node.id === 'integration' && task.delivery?.handoff?.status === 'pending' ? '待本地复核' : node.id === 'knowledge' && task.delivery?.handoff?.status === 'submitted' && !task.delivery.codeMerged ? '待代码合入' : NODE_STATUS[node.status]}</small>
      </button>)}
    </nav>
    <div ref={toolbar} data-task-toolbar className={styles.nodeToolbar}><div className={styles.nodeHeading}>
      <Button className={styles.mobileBack} type="text" icon={<ArrowLeftOutlined />} aria-label="返回任务列表" onClick={onBack} />
    <strong>{panel === 'node' ? stage.label : panel === 'execution' ? '执行过程' : '历史轮次'}</strong>
      {panel === 'node' && active === 'approval' && options.length > 1 ? <Segmented aria-label="审核产物" size="small" value={review?.kind} options={options.map(item => ({ label: item.kind === 'ui' ? 'UI 原型' : '需求范围', value: item.kind }))} onChange={value => setReviewSelection({ pendingDigest: task.review?.digest, kind: value as 'scope' | 'ui' })} /> : null}
      {panel === 'node' && review && task.approvedReviews?.some(item => item.digest === review.digest) && !pendingReview ? <Tag>已审批版本 · 只读</Tag> : null}
      {panel === 'node' && active === 'approval' ? <div className={styles.gateSummary}>{TASK_NODES[2].phases.map(id => <span key={id}>{id === 'scope_approved' ? '范围' : 'UI'}<Tag color={stage.status !== 'stale' && task.harness?.nodes.find(n => n.id === id)?.status === 'passed' ? 'green' : 'default'}>{stage.status === 'stale' ? '待更新' : task.harness?.nodes.find(n => n.id === id)?.status === 'passed' ? '已通过' : '未通过'}</Tag></span>)}</div> : null}
    </div><div className={styles.nodeTools}>
      {panel !== 'node' || active !== current ? <Button type="link" onClick={() => { setSelected(null); setPanel('node') }}>当前环节</Button> : null}
      <Button type={panel === 'execution' ? 'link' : 'text'} onClick={() => setPanel('execution')}>执行过程</Button><Button type={panel === 'history' ? 'link' : 'text'} onClick={() => setPanel('history')}>历史轮次</Button>
      <Tooltip title={expanded ? '退出展开阅读' : '展开阅读'}><Button type="text" aria-label={expanded ? '退出展开阅读' : '展开阅读'} aria-pressed={expanded} icon={expanded ? <CompressOutlined /> : <ExpandOutlined />} onClick={onToggleExpanded} /></Tooltip>
    </div></div>
    {panel === 'node' ? <p className={styles.stageBrief}><span>{NODE_STATUS[stage.status]}</span>{STAGE_BRIEF[active]}{active === 'material' ? <em>{`第 ${task.materialVersion} 版 · ${task.attachments.length} 个附件`}</em> : null}</p> : null}
    {panel === 'node' && reviewChanged ? <Alert type="warning" message="审核包已更新，旧版本不可批准" action={<Button size="small" onClick={() => setViewedDigest(review!.digest)}>查看最新审核包</Button>} /> : null}
    <div className={`${styles.nodeBody} ${panel === 'node' && (review || ((active === 'analysis' || active === 'approval') && task.harness?.reviewPackage)) ? styles.documentBody : ''}`}>
      {panel === 'node' && active === 'device' ? <DeviceAcceptanceProgress task={task} events={events} /> : null}
      {panel === 'node' && active === current && repair ? <section className={styles.repairProgress} aria-label="当前阶段返修进度"><div><strong>{repair.title}</strong><Tag color={repair.paused ? 'orange' : 'blue'}>{repair.paused ? '已暂停' : task.status === 'translation_queued' ? '已排队' : '自动处理中'}</Tag></div><ol>{repair.steps.map(step => <li key={step.label} data-status={step.status} aria-current={step.status === 'current' ? 'step' : undefined}><span aria-hidden="true">{step.status === 'passed' ? <CheckOutlined /> : null}</span>{step.label}</li>)}</ol></section> : null}
      {panel === 'node' && active === current && !['integration', 'knowledge'].includes(active) ? <RuntimeDetails harness={task.harness} /> : null}
      {body}
      {panel === 'node' && active === 'device' ? <VisualReportViewer key={task.id} taskId={task.id} version={task.harness?.checkedAt || ''} /> : null}
    </div>
    </div>
    {panel === 'node' && active === 'integration' && task.delivery?.handoff && task.status === 'awaiting_merge' ? <DeliveryHandoffFooter task={task} busy={busy} onConfirm={onConfirmDelivery} /> : panel === 'node' && review ? <HarnessReviewFooter review={review} busy={busy} canApprove={canApprove} hasDraft={hasDraft} actions={currentActions} onApprove={onApprove} /> : <footer className={styles.actions}>{currentActions || <span className={styles.readOnly}>{panel === 'history' ? '历史产物只读' : panel === 'execution' ? '实时执行记录' : '当前查看的环节无可执行操作'}</span>}</footer>}
  </section>
}
