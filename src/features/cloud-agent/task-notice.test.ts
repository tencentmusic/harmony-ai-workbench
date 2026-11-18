import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CloudAction, CloudStatus } from '@/contracts/cloud-agent'
import { taskNotice } from './task-notice'

const input = (status: CloudStatus = 'harness_waiting', actions: CloudAction[] = ['resume_translation']) => ({ status, actions, error: '平台检测到连续8轮没有新证据或调度变化，已保留进度；需要排查工具或模型空转。artifact_read：文件不存在；harness_finalize：尚未通过', sourceIssues: [] as string[], recoveryRequired: false, inputReason: '' })

test('one notice separates state, concise reason, next step and full technical details', () => {
  const value = input(), notice = taskNotice(value)!
  assert.equal(notice.title, '执行已暂停，等待继续')
  assert.match(notice.reason, /无进展保护/)
  assert.match(notice.next, /继续 Harness/)
  assert.equal(notice.details, value.error)
  assert.ok(!notice.reason.includes('artifact_read'))
})

test('recovery lock wins over errors and source issues without offering retry', () => {
  const notice = taskNotice({ ...input(), recoveryRequired: true, sourceIssues: ['仓库目录缺失'] })!
  assert.match(notice.title, /管理员/)
  assert.match(notice.next, /管理员/)
  assert.doesNotMatch(notice.next, /继续 Harness|继续分析/)
  assert.match(notice.details, /仓库目录缺失/)
  assert.match(notice.details, /artifact_read/)
})

test('actual human question is distinct from engineering failure and complete text is retained', () => {
  const question = '请确认开关配置：' + '待确认'.repeat(100)
  const notice = taskNotice({ ...input('awaiting_input', ['retry']), inputReason: question })!
  assert.equal(notice.title, '待补充业务信息')
  assert.match(notice.next, /补充资料/)
  assert.ok(notice.reason.length <= 141)
  assert.ok(notice.details.includes(question))
  assert.equal(taskNotice(input('awaiting_input', ['retry']))!.title, '分析尚未完成')
})

test('running, queued and successful states hide previous errors; environment warnings remain current', () => {
  for (const status of ['running', 'translating', 'translation_queued', 'reviewing', 'completed', 'awaiting_approval'] as const) {
    assert.equal(taskNotice(input(status)), null)
  }
  const notice = taskNotice({ ...input('translating'), sourceIssues: ['Android 源码不可用'] })!
  assert.equal(notice.title, '源码环境未就绪')
  assert.doesNotMatch(notice.details, /artifact_read/)
})

test('failed tasks use allowed actions and unknown failures are not mislabeled as missing materials', () => {
  const notice = taskNotice({ ...input('failed', []), error: '未知执行错误' })!
  assert.equal(notice.title, '本轮执行失败')
  assert.match(notice.next, /执行过程/)
  assert.doesNotMatch(notice.next, /继续 Harness|继续分析|补充资料/)
  assert.equal(taskNotice({ ...input('blocked', ['retry']), error: '' })!.title, '执行受阻')
})
