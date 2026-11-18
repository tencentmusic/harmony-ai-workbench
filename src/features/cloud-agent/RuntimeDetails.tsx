"use client";

import { useEffect, useState } from 'react'
import { Alert, Button, Select, Spin } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { CloudHarness } from '@/contracts/cloud-agent'
import { request } from './client'

const actionNames: Record<string, string> = {
  complete_build: '完成构建', complete_static_checks: '完成静态检查', complete_implementation: '完成代码实现',
  complete_reachability: '核验调用链', complete_visual_comparison_or_record_existing_decision: '核验视觉差异',
  complete_independent_review: '完成独立复核', refresh_delivery_documents_and_finalize: '更新交付文档并校验',
  restore_device_environment: '恢复设备环境', execute_required_scenarios: '执行验收场景',
  complete_acceptance_closeout: '补齐验收收尾证据', prepare_mock_fixture: '准备隔离测试数据',
  reconcile_pending_operations: '核对未决操作', repair_execution_plan: '修订执行依赖计划',
}

export function RuntimeDetails({ harness }: { harness?: CloudHarness | null }) {
  const flow = harness?.continuation
  if (!flow) return null
  return <details style={{ padding: '10px 0' }}><summary>执行计划与待办{harness?.acceptance?.closeoutMissing.length ? ` · ${harness.acceptance.closeoutMissing.length}项待收尾` : ''}</summary>
    <p>{flow.status === 'must_continue' ? '继续处理可执行任务' : flow.status === 'done' ? '执行完成' : flow.reason || '等待原生流程条件'}</p>
    {flow.pending.length ? <ul>{flow.pending.map((item, index) => <li key={index}>{item.owner === 'agent' ? '自动处理' : '待确认'}：{actionNames[item.action] || item.action}{item.scenarios.length ? ` · ${item.scenarios.join('、')}` : ''}{item.reason ? `：${item.reason}` : ''}</li>)}</ul> : null}
    {flow.blocked.length ? <ul>{flow.blocked.map((item, index) => <li key={index}>暂挂：{item.scenarios.join('、') || actionNames[item.action] || item.action} · {item.reason}{item.condition ? `；恢复条件：${item.condition}` : ''}</li>)}</ul> : null}
  </details>
}

export function VisualReportViewer({ taskId, version }: { taskId: string; version: string }) {
  const [reports, setReports] = useState<{ stateId: string; digest: string }[]>([])
  const [selected, setSelected] = useState('')
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const digest = reports.find(r => r.digest === selected)?.digest || reports[0]?.digest
  useEffect(() => {
    const controller = new AbortController()
    void request<{ reports: typeof reports }>(`/tasks/${taskId}/visual-reports`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setReports(value.reports); setError('') } }).catch(cause => { if (!controller.signal.aborted) setError(cause.message) })
    return () => controller.abort()
  }, [taskId, version, retry])
  useEffect(() => {
    if (!digest) return
    const controller = new AbortController()
    setHtml(''); setError('')
    void request<{ html: string }>(`/tasks/${taskId}/visual-reports?digest=${encodeURIComponent(digest)}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setHtml(value.html) }).catch(cause => { if (!controller.signal.aborted) setError(cause.message) })
    return () => controller.abort()
  }, [taskId, digest, retry])
  if (!reports.length && !error) return null
  return <section aria-label="视觉差异报告" style={{ padding: '16px 0', width: '100%' }}>
    <h3 style={{ fontSize: 16 }}>视觉差异报告</h3>
    {reports.length > 1 ? <Select aria-label="视觉报告状态" value={digest} style={{ minWidth: 180, maxWidth: '100%' }} options={reports.map(r => ({ value: r.digest, label: r.stateId }))} onChange={setSelected} /> : null}
    {error ? <Alert type="warning" message={error} action={<Button icon={<ReloadOutlined />} aria-label="重试视觉报告" onClick={() => setRetry(n => n + 1)} />} /> : html ? <iframe title="视觉差异 HTML 报告" sandbox="" referrerPolicy="no-referrer" srcDoc={html} style={{ display: 'block', width: '100%', height: 720, maxHeight: '80dvh', border: '1px solid #e5e7eb', marginTop: 12 }} /> : <Spin />}
  </section>
}
