import { Alert, Empty, Tag } from 'antd'
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CLOUD_STAGES, HARNESS_STAGE, type HARNESS_PHASES, type CloudHarness, type CloudStatus, type CloudReview } from '@/contracts/cloud-agent'
import styles from './CloudAgent.module.css'

export function HarnessProgress({ value, taskStatus, reviewKind, inputReason }: { value?: CloudHarness | null; taskStatus?: CloudStatus; reviewKind?: CloudReview['kind']; inputReason?: string }) {
  if (!value) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未启动 Harness" />
  const current = value.nodes.find(node => node.status !== 'passed')?.id
  const passed = value.nodes.filter(node => node.status === 'passed').length
  return <section aria-label="Harness 执行节点" className={styles.harness}>
    <div className={styles.meta}><Tag color="cyan">Harness</Tag><code>{value.branch}</code><time>{new Date(value.checkedAt).toLocaleString()}</time></div>
    {taskStatus === 'awaiting_approval' && reviewKind ? <Alert type="info" showIcon message={`需人工审批：${{ scope: '需求范围与验收标准', ui: 'UI 基线与原型', visual: '当前状态的真机视觉效果' }[reviewKind]}`} /> : taskStatus === 'awaiting_input' ? <Alert type="warning" showIcon message={inputReason ? '待人工补充：业务事实尚未确认' : '分析尚未完成，当前不是人工审批'} description={inputReason || '先查看执行记录中的具体问题。源码定位、帧关联和工具异常由 Agent 或工程侧处理；只有业务信息缺失时才需要补充材料。'} /> : null}
    {value.codeReview ? <section aria-label="代码审查报告" className={styles.markdown}>
      <h3>代码审查 <Tag color={value.codeReview.status === 'passed' ? 'green' : value.codeReview.status === 'running' ? 'blue' : 'orange'}>{{ passed: '通过', running: '审查中', failed: '待修复', stale: '需重审', pending: '待审查' }[value.codeReview.status]}</Tag></h3>
      <p>{value.codeReview.summary}</p>
      <ul>{value.codeReview.checks.map(check => <li key={check.id}>{check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '待查证'}：{check.evidence}</li>)}</ul>
      <ul>{value.codeReview.findings.map((finding, index) => <li key={index}><Tag>{finding.severity}</Tag><code>{finding.path}:{finding.line}</code> {finding.message}</li>)}</ul>
    </section> : null}
    <div className={styles.flowHeading}><strong>{current ? `当前待完成：${value.nodes.find(node => node.id === current)?.label}` : 'Harness 节点已完成'}</strong><span>{passed} / {value.nodes.length} 已通过</span></div>
    <ol className={styles.harnessNodes}>{value.nodes.map((node, index) => <li key={node.id} data-status={node.status} data-current={node.id === current} aria-current={node.id === current ? 'step' : undefined}>
      <span className={styles.nodeNumber}>{String(index + 1).padStart(2, '0')}</span>
      {node.status === 'passed' ? <CheckCircleOutlined /> : node.status === 'blocked' ? <ExclamationCircleOutlined /> : <ClockCircleOutlined />}
      <span className={styles.nodeLabel}><span>{node.label}</span><small>{CLOUD_STAGES.find(stage => stage.id === HARNESS_STAGE[node.id as typeof HARNESS_PHASES[number][0]])?.label}{['scope_approved', 'ui_prototype_approved', 'visual_parity_passed'].includes(node.id) ? ' · 人工审批' : ' · 自动执行与校验'}</small></span><small>{node.status === 'passed' ? '已通过' : node.id === current ? taskStatus === 'awaiting_approval' ? '待人工审批' : node.status === 'blocked' ? '待解决' : '当前步骤' : '后续步骤'}</small>
    </li>)}</ol>
    {value.blockers.length ? <Alert type="warning" showIcon message="尚未满足的门禁条件（不等于人工待办）" description={<ul>{value.blockers.map((item, index) => <li key={`${item.code}-${index}`}>{item.code === 'ui_state_inventory_invalid' ? 'Agent 待完善：明确 UI 适用范围，关联页面状态、Android 截图、验收项及交互区域；事实不足时须列出具体问题。' : item.message}<small> [{item.code}]</small></li>)}</ul>} /> : null}
    <details><summary>人工审批与操作节点</summary><ol>
      <li>范围审批：确认要做什么、哪些不做、验收标准和未决问题。</li>
      <li>UI 基线审批：确认状态截图和原型；无 UI 时也要确认不适用依据。</li>
      <li>代码转译：人工确认 UI 并开始转译，原生门禁通过后自动排队编码。</li>
      <li>视觉验收：自动比对通过后，逐状态确认真机效果，不替代功能测试。</li>
      <li>发起提测：交付门禁通过后确认提交；代码 MR 在代码仓审核合入。</li>
      <li>知识发布：发起知识回流，文档 MR 审核合入后才算发布。</li>
    </ol></details>
    {value.next.length ? <div><h3>下一步</h3><ul>{value.next.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    <details><summary>执行目录</summary><pre className={styles.pre}>{value.worktree}{'\n'}{value.runDir}</pre></details>
    {value.reviewPackage ? <details open><summary>Harness 审核材料</summary><article className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{value.reviewPackage}</ReactMarkdown></article></details> : null}
  </section>
}
