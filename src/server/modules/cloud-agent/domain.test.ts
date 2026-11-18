import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTaskInput, parseDecision, validBranch, parseAnalysis, canTransition, parseMergedEvent } from './domain'

test('validates task input and rejects arbitrary branches and oversized material', () => {
  assert.equal(parseTaskInput({ appId: 'KugouLive', title: '资料迁移', material: '入口 MainMe', targetBranch: 'kan-fx-release' }).title, '资料迁移')
  for (const branch of ['-force', '../release', 'refs/heads/main', 'main:other', 'main\n', 'a.lock']) assert.equal(validBranch(branch), false)
  assert.throws(() => parseTaskInput({ title: 'x', material: 'x'.repeat(60001), appId: 'a', targetBranch: 'release' }))
})
test('approval requires revision and exact artifact digest', () => {
  assert.throws(() => parseDecision({ action: 'approve', revision: 1 }))
  assert.equal(parseDecision({ action: 'approve', revision: 1, digest: 'a'.repeat(64) }).reason, '')
  assert.equal(parseDecision({ action: 'approve', revision: 1, digest: 'a'.repeat(64), reason: '已审范围' }).action, 'approve')
  assert.equal(canTransition('cancelled', 'running'), false)
  assert.equal(canTransition('awaiting_approval', 'approved'), false)
  assert.equal(canTransition('awaiting_approval', 'review_queued'), true)
  assert.equal(canTransition('running', 'approved'), false)
})
test('analysis requires structured sections and missing facts remain missing', () => {
  assert.throws(() => parseAnalysis('任务已完成'))
  const result = parseAnalysis(JSON.stringify({ summary: '分析', requirements: ['要求'], approach: ['方案'], acceptance: ['验收'], questions: ['缺入口'] }))
  assert.equal(result.questions.length, 1)
})
test('only merged MR yields a stable identity; push is ignored', () => {
  assert.equal(parseMergedEvent({ object_kind: 'push' }), null)
  const event = parseMergedEvent({ object_kind: 'merge_request', project: { id: 123, web_url: 'https://git.example/team/android' }, object_attributes: { iid: 8, state: 'merged', target_branch: 'release' } })
  assert.equal(event?.projectId, 123)
  assert.equal(event?.iid, 8)
  assert.throws(() => parseMergedEvent({ object_kind: 'merge_request', project: { id: 1, web_url: 'file:///repo' }, object_attributes: { iid: 8, state: 'merged', target_branch: 'release' } }))
  const legacy = parseMergedEvent({ object_kind: 'merge_request', project: { id: 123, web_url: 'http://git.example/team/android' }, object_attributes: { iid: 8, state: 'merged', target_branch: 'release' } })
  assert.deepEqual(legacy, event)
})
