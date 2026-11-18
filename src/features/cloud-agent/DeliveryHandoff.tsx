"use client";

import { useState } from 'react'
import { Button, Input, Tag, Typography } from 'antd'
import { CheckOutlined, ExportOutlined } from '@ant-design/icons'
import type { CloudTask } from '@/contracts/cloud-agent'
import { handoffLabel } from './delivery-presentation'
import { DeviceConclusion } from './DeviceConclusion'
import styles from './DeliveryHandoff.module.css'
import layout from './CloudAgent.module.css'

export function DeliveryHandoff({ task }: { task: CloudTask }) {
  const delivery = task.delivery, handoff = delivery?.handoff
  const repository = delivery?.repositoryUrl, branch = delivery?.branch || task.branch?.name
  const published = !!delivery?.acceptedSha && !!branch
  const branchPath = branch?.split('/').map(encodeURIComponent).join('/')
  const documents = delivery?.documentsPath?.split('/').map(encodeURIComponent).join('/')
  const checkout = branch ? `git fetch origin\ngit switch --track 'origin/${branch.replace(/'/g, "''")}'` : ''
  const message = handoff?.status !== 'submitted' && handoff?.error ? handoff.error : handoff?.status === 'submitted' ? `本地复核已确认，集成单已创建。按团队流程提测、创建并审核代码 MR；${task.deviceConclusion?.result === 'incomplete' ? '未完成的设备验收项须在提测中处理。' : '合入核实后自动回流知识。'}`
    : handoff?.status === 'closed' || handoff?.status === 'missing' ? '集成记录已关闭或关联信息不一致，请核对原记录；不会自动重跑转译。'
      : published ? '开发请拉取特性分支，在本地复核、修复和验收；点击确认提测后才创建集成单。工作台不再重跑转译与设备验收。' : '设备验收出结论后自动发布特性分支，开发本地复核并确认提测后才创建集成单。'
  return <div className={layout.stageSheet} role="region" aria-label="开发交接与提测">
    <section className={layout.stageBlock}><h3>交接说明</h3><Tag color={handoff?.status === 'submitted' ? 'green' : 'gold'}>{handoffLabel(task)}</Tag><p>{message}</p></section>
    {task.deviceConclusion ? <DeviceConclusion conclusion={task.deviceConclusion} /> : null}
    <section className={layout.stageBlock}><h3>分支信息</h3>
      <dl className={styles.facts}>
        <dt>特性分支</dt><dd>{branch ? <Typography.Text copyable={{ text: branch }}>{branch}</Typography.Text> : '尚未发布'}</dd>
        <dt>基于分支 / 合入目标</dt><dd>{delivery?.target || task.targetBranch}</dd>
        <dt>分支交接提交</dt><dd>{delivery?.acceptedSha ? <Typography.Text copyable={{ text: delivery.acceptedSha }} code>{delivery.acceptedSha}</Typography.Text> : '待生成'}</dd>
        {delivery?.mergedSourceSha ? <><dt>实际合入源提交</dt><dd><Typography.Text code copyable={{ text: delivery.mergedSourceSha }}>{delivery.mergedSourceSha}</Typography.Text></dd></> : null}
        {handoff?.submittedAt ? <><dt>本地复核确认</dt><dd>{handoff.submittedBy} · {new Date(handoff.submittedAt).toLocaleString()}</dd></> : null}
        {delivery?.documentsPath ? <><dt>分支交付文档</dt><dd><code>{delivery.documentsPath}</code></dd></> : null}
      </dl>
      {published ? <div className={styles.links}>
        {delivery?.integrationId && handoff?.status === 'submitted' ? <Button aria-label="查看提测单" icon={<ExportOutlined />} href={`/dashboard?tab=integration&integrationTask=${encodeURIComponent(delivery.integrationId)}`}>查看提测单</Button> : null}
        {repository && branchPath ? <Button icon={<ExportOutlined />} href={`${repository}/-/tree/${branchPath}`} target="_blank" rel="noopener noreferrer">查看分支代码</Button> : null}
        {repository && delivery?.acceptedSha && documents ? <Button icon={<ExportOutlined />} href={`${repository}/-/tree/${delivery.acceptedSha}/${documents}`} target="_blank" rel="noopener noreferrer">交付文档与验收记录</Button> : null}
        {delivery?.codeUrl ? <Button icon={<ExportOutlined />} href={delivery.codeUrl} target="_blank" rel="noopener noreferrer">查看代码 MR</Button> : null}
      </div> : null}
    </section>
    {published && checkout ? <section className={`${layout.stageBlock} ${styles.checkout}`}><h3>首次拉取特性分支</h3><Typography.Paragraph copyable={{ text: checkout }}><pre>{checkout}</pre></Typography.Paragraph><p>已有本地分支请切换到该分支并同步远程提交，保留未提交改动。</p></section> : null}
    {published ? <p className={styles.boundary}>设备结论仅对应上方分支提交；开发后续提交由本地复核负责。确认提测仅创建集成单，不创建或合并代码 MR。</p> : null}
  </div>
}

export function DeliveryHandoffFooter({ task, busy, onConfirm }: { task: CloudTask; busy: boolean; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const canConfirm = task.actions.includes('confirm_delivery')
  return <footer className={styles.footer} aria-label="提测确认栏">
    {canConfirm ? <details className={styles.note}><summary>补充备注（选填）</summary><Input.TextArea aria-label="提测备注（选填）" placeholder="本地复核结论或交接事项" value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} autoSize={{ minRows: 2, maxRows: 3 }} disabled={busy} /></details> : null}
    <div className={styles.confirm}><span>{handoffLabel(task)}</span>{canConfirm ? <Button aria-label="已完成本地复核，确认提测" type="primary" icon={<CheckOutlined />} loading={busy} disabled={busy} onClick={() => { void onConfirm(reason).catch(() => {}) }}>已完成本地复核，确认提测</Button> : <span className={styles.boundary}>{task.delivery?.handoff?.status === 'submitted' ? '等待代码 MR 合入，无需再次确认' : '请核对集成记录'}</span>}</div>
  </footer>
}
