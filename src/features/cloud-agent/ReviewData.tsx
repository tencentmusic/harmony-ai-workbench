import { Children, isValidElement, type ReactNode } from 'react'
import styles from './HarnessReview.module.css'

const labels: Record<string, string> = {
  items: '验收事项', ui_scope: '界面适用范围', scenarios: '验收场景', id: '编号', status: '状态', behavior: '业务行为',
  strategy: '迁移策略', basis: '依据', android_current: 'Android 现状', harmony_current: '鸿蒙现状',
  acceptance_ids: '关联验收项', evidence_ids: '关联证据', states: '页面与状态', name: '名称', description: '说明',
  preconditions: '前置条件', steps: '操作步骤', expected: '预期结果', expected_result: '预期结果',
  expected_observation: '预期观察', assertions: '断言', state_id: '状态编号', kind: '类型', title: '标题',
  entry: '入口', source: '来源', path: '证据位置', reason: '原因', notes: '补充说明',
}

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span>未填写</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value !== 'object') return <span>{String(value)}</span>
  if (depth > 5) return <pre>{JSON.stringify(value, null, 2)}</pre>
  if (Array.isArray(value)) return value.length ? <ol className={styles.factList}>{value.map((item, index) => <li key={index}><Value value={item} depth={depth + 1} /></li>)}</ol> : <span>无</span>
  return <dl className={styles.facts}>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{labels[key] || key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}</dl>
}

export function ReviewData({ children }: { children: ReactNode }) {
  const code = Children.toArray(children)[0]
  let facts: Record<string, unknown> | null = null
  if (isValidElement<{ className?: string; children?: ReactNode }>(code) && code.props.className === 'language-json' && typeof code.props.children === 'string') {
    try {
      const value: unknown = JSON.parse(code.props.children)
      if (value && typeof value === 'object' && !Array.isArray(value) && ['items', 'ui_scope', 'scenarios'].some(key => key in value)) facts = value as Record<string, unknown>
    } catch { /* Preserve invalid or unrelated structured text in the original block. */ }
  }
  return <>
    {facts ? Object.entries(facts).map(([key, value]) => <div key={key}><h3>{labels[key] || key}</h3><Value value={value} /></div>) : null}
    <details className={styles.raw}><summary>原始明细</summary><pre>{children}</pre></details>
  </>
}
