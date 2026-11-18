"use client";

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Drawer, Dropdown, Empty, Form, Input, Pagination, Popconfirm, Select, Spin, Tabs, Tag, Tooltip } from 'antd'
import { DataTable } from '@/shared/data-table/DataTable'
import { CloseOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, PlusOutlined, ReloadOutlined, BranchesOutlined, CloudServerOutlined, MoreOutlined } from '@ant-design/icons'
import { CLOUD_STAGES, cloudStageForStatus, type CloudAction, type CloudApp, type CloudEvent, type CloudStatus, type CloudTask, type CloudTaskList, type CloudStageId, type CloudSummary } from '@/contracts/cloud-agent'
import type { TimeRangeId } from '@/contracts/time-range'
import { TimeRangeTabs } from '@/shared/time-range/TimeRangeTabs'
import { LifecycleOverview } from './LifecycleOverview'
import { MaterialAttachments } from './MaterialAttachments'
import { TaskWorkspace } from './TaskWorkspace'
import { TaskBranch } from './TaskBranch'
import { ExecutionSummary } from './ExecutionProgress'
import { humanInputReason } from './execution-progress'
import { TaskNotice } from './TaskNotice'
import { taskNotice } from './task-notice'
import { subscribeCloudEvents } from './event-stream'
import { request, RequestError } from './client'
import { useTaskDetail } from './useTaskDetail'
import { handoffLabel } from './delivery-presentation'
import type { CloudAttachment } from '@/contracts/cloud-agent'
import styles from './CloudAgent.module.css'

const statusMeta: Record<CloudStatus, { label: string; color: string }> = {
  delivery_ready: { label: '待提测', color: 'green' }, device_concluded: { label: '验收有待办 · 待提测', color: 'orange' }, delivery_queued: { label: '交付排队', color: 'default' }, delivering: { label: '交付处理中', color: 'processing' }, awaiting_merge: { label: '代码待合入', color: 'cyan' }, knowledge_review: { label: '文档待合入', color: 'cyan' }, completed: { label: '已完成', color: 'green' },
  queued: { label: '排队中', color: 'default' }, running: { label: '分析中', color: 'processing' },
  awaiting_input: { label: '分析待完善', color: 'orange' }, awaiting_approval: { label: '待人工审批', color: 'gold' },
  approved: { label: '待转译', color: 'green' }, blocked: { label: '已阻塞', color: 'red' },
  cancelling: { label: '正在停止', color: 'orange' }, cancelled: { label: '已取消', color: 'default' }, failed: { label: '失败', color: 'red' },
  translation_queued: { label: '转译排队', color: 'default' }, translating: { label: 'Harness 执行中', color: 'processing' },
  harness_waiting: { label: '执行待继续', color: 'orange' }, code_ready: { label: '代码待验证', color: 'cyan' },
  review_queued: { label: '审批登记排队', color: 'default' }, reviewing: { label: '审批后推进中', color: 'processing' },
}
function Status({ status, task }: { status: CloudStatus; task?: CloudTask }) {
  if (status === 'completed' && task?.deviceConclusion?.result === 'incomplete') return <Tag color="orange">代码已合入 · 验收未完成</Tag>
  const meta = statusMeta[status] || { label: status, color: 'default' }
  return <Tag color={task?.delivery?.handoff?.status === 'pending' ? 'gold' : meta.color}>{status === 'awaiting_merge' && task?.delivery?.handoff ? handoffLabel(task) : meta.label}</Tag>
}
function taskStageName(task: CloudTask) {
  if (task.status === 'cancelled') return '已结束'
  return CLOUD_STAGES.find(item => item.id === task.stage)?.label || cloudStageForStatus(task.status)?.label || '需求材料'
}
export function CloudAgent({ active }: { active: boolean }) {
  const { message, modal } = App.useApp()
  const [apps, setApps] = useState<CloudApp[]>([])
  const [tasks, setTasks] = useState<CloudTask[]>([])
  const [selected, setSelected] = useState<string>('')
  const [visible, setVisible] = useState(true)
  const enabled = active && visible
  const { detail, error: detailError, ready: detailReady, refresh: refreshDetail, accept: setDetail, clear: clearDetail } = useTaskDetail(selected, enabled)
  const [events, setEvents] = useState<CloudEvent[]>([])
  const [view, setView] = useState('pipeline')
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('cloudTask')
    if (id && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) { setSelected(id); setView('tasks') }
  }, [])
  const [readingExpanded, setReadingExpanded] = useState(false)
  useEffect(() => { setReadingExpanded(false) }, [selected])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [appId, setAppId] = useState<string>()
  const [stage, setStage] = useState<CloudStageId>()
  const [filter, setFilter] = useState('all')
  const [range, setRange] = useState<TimeRangeId>('all')
  const [summary, setSummary] = useState<CloudSummary | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [revising, setRevising] = useState(false)
  const [material, setMaterial] = useState('')
  const [attachments, setAttachments] = useState<CloudAttachment[]>([])
  const [createAttachments, setCreateAttachments] = useState<CloudAttachment[]>([])
  const [materialBusy, setMaterialBusy] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: string; appId: string; version: number } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { material: string; attachments: CloudAttachment[]; version: number }>>({})
  const [branches, setBranches] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [form] = Form.useForm<{ appId: string; targetBranch: string; title: string; material: string }>()
  const createAppId = Form.useWatch('appId', form)
  const createDefaultBranch = apps.find(app => app.id === createAppId)?.defaultBranch
  const listGeneration = useRef(0)
  const listPending = useRef(new Map<string, Promise<CloudTaskList>>())
  const streamConnected = useRef(false)
  const eventCursor = useRef(new Map<string, number>())
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    update(); document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useEffect(() => {
    let token = localStorage.getItem('hm_token') || ''
    const clear = () => { clearDetail(); listGeneration.current++; listPending.current.clear(); eventCursor.current.clear(); setSelected(''); setTasks([]); setEvents([]); setApps([]); setDrafts({}); setSummary(null); setRevising(false); setCreating(false) }
    const changed = () => { const next = localStorage.getItem('hm_token') || ''; if (next !== token) { token = next; clear() } }
    window.addEventListener('storage', changed); window.addEventListener('focus', changed); window.addEventListener('cloud-agent-auth-invalid', clear)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', changed); window.removeEventListener('cloud-agent-auth-invalid', clear) }
  }, [clearDetail])
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1) }, 300); return () => clearTimeout(timer) }, [query])
  const refresh = useCallback(async (quiet = false) => {
    const generation = ++listGeneration.current
    if (!quiet) setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), q: search, ...(appId ? { appId } : {}), ...(view === 'pipeline' && stage ? { stage } : {}), ...(view === 'pipeline' && range !== 'all' ? { range } : {}), ...(view === 'tasks' ? { filter } : {}) })
      const key = params.toString()
      let pending = listPending.current.get(key)
      if (!pending) {
        pending = request<CloudTaskList>(`/tasks?${params}`).finally(() => { if (listPending.current.get(key) === pending) listPending.current.delete(key) })
        listPending.current.set(key, pending)
      }
      const data = await pending
      if (generation === listGeneration.current) { setTasks(data.items); setTotal(data.total); setSummary(data.summary); setError('') }
    } catch (e) { if (generation === listGeneration.current) { setError((e as Error).message); setSummary(null); if (e instanceof RequestError && [401, 403].includes(e.status)) { setTasks([]); clearDetail(); setEvents([]) } } }
    finally { if (generation === listGeneration.current) setLoading(false) }
  }, [page, search, appId, stage, view, filter, range, clearDetail])
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    const load = () => { void request<{ items: CloudApp[] }>('/apps', { signal: abort.signal }).then(data => { if (!abort.signal.aborted) setApps(data.items) }).catch(e => { if (!abort.signal.aborted) setError(e.message) }) }
    load()
    const timer = setInterval(load, 60000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let lastPoll = Date.now()
    async function poll() {
      if (Date.now() - lastPoll >= (streamConnected.current ? 30000 : 5000)) {
        lastPoll = Date.now()
        await Promise.all([refresh(true), refreshDetail()])
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    void refresh(); timer = setTimeout(() => void poll(), 1000)
    return () => { stopped = true; clearTimeout(timer); listGeneration.current++ }
  }, [enabled, refresh, refreshDetail])
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let detailChanged = false, ready = false
    const changed = (event?: CloudEvent) => {
      if (event && ['tool', 'output', 'continuation', 'warning'].includes(event.kind)) return
      detailChanged ||= !event || event.taskId === selectedRef.current
      if (timer || abort.signal.aborted) return
      timer = setTimeout(() => { timer = undefined; void refresh(true); if (detailChanged) void refreshDetail(); detailChanged = false }, 500)
    }
    const focus = () => changed()
    void subscribeCloudEvents('/events', abort.signal, changed, () => { if (ready) changed(); ready = true }, connected => { streamConnected.current = connected })
    window.addEventListener('focus', focus)
    return () => { abort.abort(); streamConnected.current = false; clearTimeout(timer); window.removeEventListener('focus', focus) }
  }, [enabled, refresh, refreshDetail])
  useEffect(() => {
    setEvents([]); eventCursor.current.delete(selected)
  }, [selected])
  useEffect(() => {
    if (!enabled || !selected) return
    const abort = new AbortController()
    void subscribeCloudEvents(`/tasks/${encodeURIComponent(selected)}/events`, abort.signal,
      event => { if (selectedRef.current === selected) { eventCursor.current.set(selected, event.id); setEvents(previous => previous.some(item => item.id === event.id) ? previous : [...previous, event].slice(-500)) } }, () => {}, undefined, eventCursor.current.get(selected))
    return () => abort.abort()
  }, [selected, enabled])
  useEffect(() => {
    if (!creating || !createAppId) return
    const abort = new AbortController()
    form.setFieldsValue({ targetBranch: createDefaultBranch })
    setBranches(createDefaultBranch ? [createDefaultBranch] : []); setBranchError(''); setBranchLoading(true)
    void request<{ items: string[] }>(`/branches?appId=${encodeURIComponent(createAppId)}`, { signal: abort.signal })
      .then(data => { if (!abort.signal.aborted) { setBranches(data.items); if (!data.items.includes(createDefaultBranch || '')) form.setFieldsValue({ targetBranch: undefined }) } })
      .catch(e => { if (!abort.signal.aborted) setBranchError(e.message) })
      .finally(() => { if (!abort.signal.aborted) setBranchLoading(false) })
    return () => abort.abort()
  }, [creating, createAppId, createDefaultBranch, form])
  async function create() {
    try {
      const values = await form.validateFields()
      if (createBusy) return
      if (!values.material?.trim() && !createAttachments.length) { message.error('请填写文字或上传附件'); return }
      setSubmitting(true)
      const data = await request<{ item: CloudTask }>('/tasks', { method: 'POST', body: JSON.stringify({ ...values, material: values.material || '', attachmentIds: createAttachments.map(item => item.id) }) })
      setCreating(false); setSelected(data.item.id); setView('tasks'); await refresh(); message.success('已创建分析任务')
    } catch (e) { if (e instanceof Error) message.error(e.message) } finally { setSubmitting(false) }
  }
  function confirmDelete(task: { id: string; title: string }) {
    modal.confirm({ title: '删除此任务？', content: `${task.title}：将删除需求材料、附件、执行记录、提测资料和该任务的特性分支，且不能恢复。执行中的任务请先取消。`, okText: '确认删除', cancelText: '返回', okButtonProps: { danger: true }, onOk: () => erase(task.id) })
  }
  function taskActionsMenu(task: { id: string; title: string; owned?: boolean }, placement: 'card' | 'row') {
    if (!task.owned) return null
    return <Dropdown trigger={['click']} menu={{ items: [{ key: 'delete', icon: <DeleteOutlined />, danger: true, label: '删除任务' }], onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); if (key === 'delete') confirmDelete(task) } }}><Button type="text" size="small" className={placement === 'card' ? styles.taskMenu : styles.rowMenu} icon={<EllipsisOutlined />} aria-label={`${task.title} 更多操作`} onClick={event => event.stopPropagation()} /></Dropdown>
  }
  async function erase(id: string) {
    setSubmitting(true)
    try {
      await request(`/tasks/${id}`, { method: 'DELETE' }, 120000)
      if (selected === id) setSelected('')
      await refresh()
      message.success('已删除任务及其分支和资料')
    } catch (error) { message.error((error as Error).message) }
    finally { setSubmitting(false) }
  }
  async function decide(action: CloudAction, digest = '', reason = '') {
    if (!detail) return
    if (!detailReady) {
      message.warning('任务状态正在更新，请稍后操作')
      if (action === 'approve' || action === 'confirm_delivery') throw new Error('任务状态尚未校准')
      return
    }
    setSubmitting(true)
    try {
      const data = await request<{ item: CloudTask }>(`/tasks/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ action, revision: detail.revision, digest, reason }) })
      setDetail(data.item)
      if (action === 'confirm_delivery') message.success('已确认提测，集成单已创建')
      await refresh(true)
    } catch (e) { message.error((e as Error).message); if (action === 'approve' || action === 'confirm_delivery') throw e } finally { setSubmitting(false) }
  }
  async function saveMaterials() {
    if (!editing || materialBusy) return
    setSubmitting(true)
    try {
      const data = await request<{ item: CloudTask }>(`/tasks/${editing.id}/materials`, { method: 'PATCH', body: JSON.stringify({ material, materialVersion: editing.version, attachmentIds: attachments.map(item => item.id), reanalyze: true }) })
      setDetail(data.item)
      setDrafts(previous => { const next = { ...previous }; delete next[editing.id]; return next })
      setRevising(false); await refresh(true); message.success('修改已提交，已排队重新分析')
    } catch (e) { message.error((e as Error).message) } finally { setSubmitting(false) }
  }
  function editMaterials() {
    if (!detail) return
    const draft = drafts[detail.id]
    setMaterial(draft?.material ?? detail.material); setAttachments(draft?.attachments ?? detail.attachments)
    setEditing({ id: detail.id, appId: detail.appId, version: draft?.version ?? detail.materialVersion }); setMaterialBusy(false); setRevising(true)
  }
  function saveDraft() {
    if (!editing || materialBusy) return
    if (detail?.id === editing.id && detail.materialVersion === editing.version && detail.material.trim() === material.trim() && JSON.stringify(detail.attachments.map(item => item.id)) === JSON.stringify(attachments.map(item => item.id))) {
      setDrafts(previous => { const next = { ...previous }; delete next[editing.id]; return next })
      setRevising(false); return
    }
    setDrafts(previous => ({ ...previous, [editing.id]: { material, attachments, version: editing.version } }))
    setRevising(false); message.success('已暂存当前页面草稿，未改变正式材料')
  }
  const latest = detail?.runs[0]
  const detailApp = apps.find(app => app.id === detail?.appId)
  const detailIssues = detailApp?.sourceIssues || []
  const unavailableApps = apps.filter(app => (!appId || app.id === appId) && app.sourceIssues?.length)
  const createUnavailable = !!apps.find(app => app.id === createAppId)?.sourceIssues?.length
  const selectStage = (value: CloudStageId) => { setStage(previous => previous === value ? undefined : value); setPage(1) }
  const choose = (id: string) => { setSelected(id); setView('tasks') }
  const materialAction = detail && !detail.delivery?.handoff ? <Button aria-label="补充资料或提出修改" icon={<EditOutlined />} disabled={submitting || detail.delivery?.frozen || ['delivery_queued', 'delivering', 'completed', 'cancelled'].includes(detail.status)} onClick={editMaterials}>{drafts[detail.id] ? '编辑未提交草稿' : '补充资料 / 提出修改'}</Button> : null
  const taskActions = detail ? <>
      {detail.actions.includes('submit_delivery') ? <Popconfirm title={detail.deviceConclusion?.result === 'incomplete' ? '发布带未完成设备结论的特性分支，交由开发本地复核？' : '发布已验收特性分支供开发本地复核？确认提测后才创建集成单。'} onConfirm={() => decide('submit_delivery')}><Button aria-label="发布特性分支" type="primary" icon={<BranchesOutlined />} loading={submitting}>发布特性分支</Button></Popconfirm> : null}
      {detail.actions.includes('sync_delivery') ? <Button aria-label="核验合入状态" icon={<ReloadOutlined />} loading={submitting} onClick={() => void decide('sync_delivery')}>核验合入状态</Button> : null}
      {detail.actions.includes('publish_knowledge') && detail.delivery?.codeMerged ? <Popconfirm title="向配置的知识库创建四文档回流 MR？" onConfirm={() => decide('publish_knowledge')}><Button aria-label="回流知识库" icon={<BranchesOutlined />} loading={submitting}>回流知识库</Button></Popconfirm> : null}
      {detail.actions.includes('translate') || detail.actions.includes('resume_translation') ? <Button aria-label={detail.actions.includes('translate') ? '开始转译' : '继续 Harness'} type="primary" icon={<CloudServerOutlined />} loading={submitting} onClick={() => void decide(detail.actions.includes('translate') ? 'translate' : 'resume_translation')}>{detail.actions.includes('translate') ? '开始转译' : '继续 Harness'}</Button> : null}
      {materialAction}
      {detail.actions.includes('retry') && !detail.actions.includes('approve') && !detail.actions.includes('resume_translation') ? <Tooltip title={detailIssues.length ? '恢复双端源码仓库后可继续分析' : undefined}><Button icon={<ReloadOutlined />} disabled={!!detailIssues.length || !!drafts[detail.id]} loading={submitting} onClick={() => void decide('retry')}>继续分析</Button></Tooltip> : null}
  </> : null
  const taskSummary = detail ? <div className={styles.taskSummary}>
      <header className={styles.detailHeader}><h2>{detail.title}</h2><Status status={detail.status} task={detail} />
        {detail.owned || detail.actions.includes('cancel') ? <Dropdown trigger={['click']} menu={{ items: [...(detail.owned ? [{ key: 'delete', label: '删除任务', icon: <DeleteOutlined />, danger: true, disabled: submitting }] : []), ...(detail.actions.includes('cancel') ? [{ key: 'cancel', label: '取消任务', icon: <CloseOutlined />, danger: true, disabled: submitting }] : [])], onClick: ({ key }) => { if (key === 'delete') confirmDelete(detail); if (key === 'cancel') modal.confirm({ title: '停止此任务？', content: `${detail.title}：已有材料和记录将保留。`, okText: '确认取消', cancelText: '返回', okButtonProps: { danger: true }, onOk: () => decide('cancel') }) } }}><Button type="text" aria-label="更多任务操作" icon={<MoreOutlined />} /></Dropdown> : null}
      </header>
      <div className={styles.branch}><span>{detailApp?.label || detail.appId}</span><TaskBranch task={detail} />{detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Android MR</a> : null}
        <details className={styles.taskInformation}><summary>任务信息</summary><div className={styles.meta}><span>第 {detail.revision} 轮</span><span>{detail.model}</span>{detail.branch?.sha ? <code>基线 {detail.branch.sha}</code> : null}</div><ExecutionSummary events={events} run={latest} status={detail.status} /></details>
      </div>
      {latest && detail.materialVersion !== latest.materialVersion ? <Alert type="warning" showIcon message={`材料 v${detail.materialVersion} · 当前方案基于 v${latest.materialVersion}，待重新分析`} /> : null}
      <TaskNotice key={`${detail.id}:${detail.revision}:${detail.status}`} value={taskNotice({ status: detail.status, actions: detail.actions, error: latest?.error || '', sourceIssues: detailIssues, recoveryRequired: !!detail.recoveryRequired, inputReason: detail.status === 'awaiting_input' ? humanInputReason(events, latest?.id) : '' })} />
      {detailError ? <Alert type="warning" message={`刷新失败：${detailError}`} action={<Button icon={<ReloadOutlined />} onClick={() => void refreshDetail()}>重试</Button>} /> : null}
    </div> : null
  const taskDetail = detail ? <TaskWorkspace key={detail.id} summary={taskSummary} expanded={readingExpanded} onToggleExpanded={() => setReadingExpanded(value => !value)} onBack={() => setSelected('')} task={detail} events={events} busy={submitting || !detailReady} hasDraft={!!drafts[detail.id] || revising || !detailReady} actions={taskActions} materialAction={materialAction} onApprove={(digest, reason) => decide('approve', digest, reason)} onConfirmDelivery={reason => decide('confirm_delivery', '', reason)} /> : <div className={styles.detailPlaceholder} aria-label="任务详情占位">
    {selected ? detailError ? <div className={styles.detailFeedback} role="alert"><span>任务读取失败</span><small>{detailError}</small><Button aria-label="重新加载" icon={<ReloadOutlined />} onClick={() => void refreshDetail()}>重新加载</Button></div> : <div className={styles.detailFeedback} role="status"><Spin /><span>正在读取任务</span></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个任务" />}
  </div>
  const filters = <div className={styles.filters}><Select allowClear aria-label="筛选App" placeholder="全部App" value={appId} options={apps.map(app => ({ label: app.label, value: app.id }))} onChange={value => { setAppId(value); setPage(1); setSelected('') }} /><Input allowClear aria-label="搜索需求" placeholder="搜索需求名称或 ID" value={query} onChange={event => setQuery(event.target.value)} className={styles.searchInput} />{view === 'pipeline' ? <TimeRangeTabs value={range} onChange={value => { setRange(value); setPage(1) }} /> : null}<Tooltip title="刷新"><Button aria-label="刷新" icon={<ReloadOutlined />} onClick={() => void refresh()} /></Tooltip></div>
  const pagination = <div className={styles.pagination}><Pagination simple current={page} total={total} pageSize={30} showSizeChanger={false} onChange={setPage} /></div>
  return <section className={`${styles.root} ${view === 'tasks' ? styles.tasksRoot : ''}`}>
    <header className={styles.header}><Tabs activeKey={view} onChange={value => { setView(value); setPage(1) }} items={[{ key: 'pipeline', label: '需求流水线' }, { key: 'tasks', label: '任务列表' }]} /><Button aria-label="新增转译任务" type="primary" icon={<PlusOutlined />} disabled={!apps.length} onClick={() => { form.resetFields(); form.setFieldsValue({ appId: apps[0]?.id }); setCreateAttachments([]); setCreateBusy(false); setCreating(true) }}>新增转译任务</Button></header>
    {view === 'pipeline' ? <LifecycleOverview summary={summary} selected={stage} onSelect={selectStage} /> : null}
    {error ? <Alert type="error" showIcon message={error} /> : null}
    {unavailableApps.length ? <Alert className={styles.environmentAlert} type="warning" showIcon message={<details><summary>{unavailableApps.length} 个 App 的源码环境未就绪</summary><ul className={styles.issueList}>{unavailableApps.map(app => <li key={app.id}><strong>{app.label}</strong>：{app.sourceIssues?.join('；')}</li>)}</ul></details>} /> : null}
    {view === 'pipeline' ? filters : null}
    {view === 'pipeline' && stage ? <div className={styles.filterHeading}><strong>{CLOUD_STAGES.find(item => item.id === stage)?.label}</strong><span>{total} 个需求</span><Button aria-label="清除筛选" type="text" size="small" icon={<CloseOutlined />} onClick={() => { setStage(undefined); setPage(1) }}>清除筛选</Button></div> : null}
    {view === 'pipeline' ? <div className={styles.table}><DataTable tableKey="cloud-agent-pipeline" rowKey="id" dataSource={tasks} loading={loading} pagination={false} columns={[
      { title: '需求', dataIndex: 'title', width: 290, sorter: (left: CloudTask, right: CloudTask) => left.title.localeCompare(right.title, 'zh'), render: (title: string, row: CloudTask) => <div className={styles.requirementCell}><button className={styles.link} onClick={() => choose(row.id)}>{title}</button><small>{row.id}</small></div> },
      { title: 'App', dataIndex: 'appId', width: 120, sorter: (left: CloudTask, right: CloudTask) => (apps.find(app => app.id === left.appId)?.label || left.appId).localeCompare(apps.find(app => app.id === right.appId)?.label || right.appId, 'zh'), render: (value: string) => apps.find(app => app.id === value)?.label || value },
      { title: '当前阶段', dataIndex: 'status', width: 120, sorter: (left: CloudTask, right: CloudTask) => (CLOUD_STAGES.find(item => item.id === left.stage)?.label || '').localeCompare(CLOUD_STAGES.find(item => item.id === right.stage)?.label || '', 'zh'), render: (value: CloudStatus, row: CloudTask) => <span className={styles.stageLabel}>{value === 'cancelled' ? '已结束' : CLOUD_STAGES.find(item => item.id === row.stage)?.label || cloudStageForStatus(value)?.label || '已结束'}</span> },
      { title: '执行状态', key: 'execution', dataIndex: 'status', width: 170, sorter: (left: CloudTask, right: CloudTask) => statusMeta[left.status].label.localeCompare(statusMeta[right.status].label, 'zh'), render: (value: CloudStatus, task: CloudTask) => <Status status={value} task={task} /> },
      { title: '特性分支 / 创建基线', key: 'branch', width: 280, sorter: (left: CloudTask, right: CloudTask) => (left.branch?.name || '').localeCompare(right.branch?.name || '', 'zh'), render: (_: unknown, row: CloudTask) => <TaskBranch task={row} /> }, { title: '来源', dataIndex: 'source', width: 110, sorter: (left: CloudTask, right: CloudTask) => left.source.localeCompare(right.source, 'zh'), render: (value: string) => value === 'android-mr' ? 'Android MR' : '手动创建' },
      { title: '更新时间', dataIndex: 'updatedAt', width: 170, sorter: (left: CloudTask, right: CloudTask) => left.updatedAt.localeCompare(right.updatedAt), render: (value: string) => new Date(value).toLocaleString() },
      { title: '', key: 'actions', width: 48, align: 'right', render: (_: unknown, row: CloudTask) => taskActionsMenu(row, 'row') },
    ]} /></div> : <div className={styles.workspace} data-reading-expanded={readingExpanded} data-has-task={!!selected}><aside className={styles.taskSidebar} aria-label="任务列表">
      {filters}<Select aria-label="任务状态筛选" value={filter} onChange={value => { setFilter(value); setPage(1) }} options={[{ value: 'all', label: '全部任务' }, { value: 'active', label: '进行中' }, { value: 'confirmation', label: '待我审核' }, { value: 'issues', label: '异常 / 待补充' }, { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消 / 停止中' }]} />
      <div className={styles.taskList}>{loading && !tasks.length ? <Spin /> : tasks.length ? tasks.map(task => <div key={task.id} className={`${styles.task} ${selected === task.id ? styles.selected : ''}`}><button type="button" aria-pressed={selected === task.id} className={`${styles.taskMain} ${task.owned ? styles.taskMainOwned : ''}`} onClick={() => setSelected(task.id)}><strong className={styles.taskTitle}>{task.title}</strong><span className={styles.taskTags}><span className={styles.stageChip}>{taskStageName(task)}</span><Status status={task.status} task={task} /></span><small className={styles.taskApp}>{apps.find(app => app.id === task.appId)?.label || task.appId} · {task.creatorName || '未知创建人'}</small></button>{taskActionsMenu(task, 'card')}</div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />}</div>{pagination}
    </aside><main className={styles.detail}>{taskDetail}</main></div>}
    {view === 'pipeline' ? pagination : null}
    <Drawer title="新增转译任务" forceRender open={creating} width={600} onClose={() => { if (!submitting) setCreating(false) }} extra={<Button type="primary" disabled={createBusy || branchLoading || !!branchError || createUnavailable} onClick={() => void create()} loading={submitting}>创建并分析</Button>}>
      {createUnavailable ? <Alert type="warning" showIcon message="源码环境未就绪" description={<ul className={styles.issueList}>{apps.find(app => app.id === createAppId)?.sourceIssues?.map(issue => <li key={issue}>{issue}</li>)}</ul>} /> : null}
      <Form form={form} layout="vertical" disabled={submitting} onValuesChange={changed => { if ('appId' in changed) { setCreateAttachments([]); setCreateBusy(false) } }}><Form.Item name="appId" label="目标 App" rules={[{ required: true }]}><Select options={apps.map(app => ({ label: app.label, value: app.id }))} /></Form.Item><Form.Item name="targetBranch" label="鸿蒙目标分支" rules={[{ required: true }]}><Select showSearch loading={branchLoading} options={branches.map(value => ({ label: value, value }))} /></Form.Item>{branchError ? <Alert type="warning" message={branchError} /> : null}<Form.Item name="title" label="需求名称" rules={[{ required: true, max: 160 }]}><Input maxLength={160} /></Form.Item><Form.Item name="material" label="需求材料" rules={[{ max: 60000 }]}><Input.TextArea rows={6} maxLength={60000} showCount placeholder="业务目标、Android 入口、差异要求和验收条件" /></Form.Item>
        {creating ? <MaterialAttachments key={createAppId} appId={createAppId || ''} items={createAttachments} onChange={setCreateAttachments} onBusyChange={setCreateBusy} disabled={submitting} /> : null}
        <Tag>{apps.find(app => app.id === createAppId)?.model || 'gpt-6-astra'}</Tag></Form>
    </Drawer>
    <Drawer title={`补充资料 / 提出修改 · 基于材料 v${editing?.version || 1}`} open={revising} width={600} onClose={() => { if (!submitting && !materialBusy) saveDraft() }} destroyOnHidden footer={<div className={styles.actionButtons}>
      <Button disabled={submitting || materialBusy} onClick={saveDraft}>暂存草稿</Button>
      <Button disabled={submitting || materialBusy} onClick={() => { if (editing) setDrafts(previous => { const next = { ...previous }; delete next[editing.id]; return next }); setRevising(false) }}>放弃修改</Button>
      <Button type="primary" loading={submitting} disabled={materialBusy || !!detail && ['running', 'translating', 'reviewing', 'delivering', 'cancelling', 'cancelled', 'completed'].includes(detail.status)} onClick={() => void saveMaterials()}>提交修改并重新分析</Button>
    </div>}>
      {editing && detail?.id === editing.id && detail.materialVersion !== editing.version ? <Alert type="warning" message={`正式材料已更新至 v${detail.materialVersion}，请先备份草稿并重新打开最新材料，不能覆盖提交。`} /> : null}
      {detail && ['running', 'translating', 'reviewing', 'cancelling'].includes(detail.status) ? <Alert type="info" message="当前仍在执行，可暂存草稿，本轮结束后再提交。" /> : null}
      <Input.TextArea aria-label="补充材料" rows={8} maxLength={60000} showCount value={material} disabled={submitting} onChange={event => setMaterial(event.target.value)} />
      {revising && editing ? <MaterialAttachments key={`${editing.id}-${editing.version}`} appId={editing.appId} items={attachments} onChange={setAttachments} onBusyChange={setMaterialBusy} disabled={submitting} /> : null}
    </Drawer>
  </section>
}
