import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notificationState, notificationPayload, notificationRecipient, validateWecomWebhook } from './notification-domain'

const task = { id: 'task1', title: '封面播放', appId: 'Live', revision: 2, materialVersion: 1, status: 'awaiting_approval', harnessJson: JSON.stringify({ review: { kind: 'ui', digest: 'abc' } }) }
test('human gates notify, running states do not and approval changes invalidate old notices', () => {
  assert.match(notificationState(task)!.reason, /UI/)
  assert.equal(notificationState({ ...task, status: 'translating' }), null)
  assert.notEqual(notificationState(task)!.key, notificationState({ ...task, revision: 3 })!.key)
  for (const status of ['awaiting_input', 'harness_waiting', 'failed', 'blocked', 'approved', 'code_ready']) assert.ok(notificationState({ ...task, status }))
  assert.equal(notificationState({ ...task, status: 'cancelled' }), null)
})
test('handoff notice is stable across polling revisions but rework creates another notice', () => {
  const handed = { ...task, status: 'awaiting_merge', harnessJson: JSON.stringify({ delivery: { integrationId: 'i1', codeSnapshot: { sha: 'a' } } }) }
  assert.equal(notificationState(handed)!.key, notificationState({ ...handed, revision: 4 })!.key)
  assert.notEqual(notificationState(handed)!.key, notificationState({ ...handed, harnessJson: JSON.stringify({ delivery: { integrationId: 'i2', codeSnapshot: { sha: 'b' } } }) })!.key)
})
test('recipients use explicit mappings or fallback; never assume employee code is userid', () => {
  assert.deepEqual(notificationRecipient('123', {}, { userId: 'jaydenxxiao' }), { userId: 'jaydenxxiao' })
  assert.deepEqual(notificationRecipient('123', { '123': { mobile: '13800001111' } }, { userId: 'fallback' }), { mobile: '13800001111' })
  assert.throws(() => notificationRecipient(null, {}, {}), /接收人/)
  assert.throws(() => notificationRecipient(null, {}, { userId: '@all' }), /接收人/)
})
test('WeCom payload respects utf8 byte limit and includes explicit mention and usable URL', () => {
  const payload = notificationPayload({ ...task, title: '长标题'.repeat(3000) }, notificationState(task)!, { userId: 'jaydenxxiao' }, 'http://192.168.1.10:3100')
  assert.ok(Buffer.byteLength(payload.text.content) <= 2048)
  assert.match(payload.text.content, /192\.168\.1\.10:3100/)
  assert.match(payload.text.content, /cloudTask=task1/)
  assert.ok('mentioned_list' in payload.text)
  assert.deepEqual(payload.text.mentioned_list, ['jaydenxxiao'])
  assert.throws(() => notificationPayload(task, notificationState(task)!, { userId: 'u' }, 'http://localhost:3100'), /地址/)
})
test('webhook rejects other hosts, credentials, redirects and extra query fields', () => {
  assert.ok(validateWecomWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic'))
  for (const url of ['https://evil.test/send?key=x', 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&other=y']) assert.throws(() => validateWecomWebhook(url))
})

test('task notices use the requested title, configured Chinese app name and actual lifecycle stage', () => {
  for (const [appId, label] of [['KugouLive', '酷狗直播'], ['KugouPlayer', '酷狗音乐']]) {
    const current = { ...task, appId, status: 'failed', stage: 'integration' }
    const payload = notificationPayload(current, notificationState(current)!, { userId: 'owner' }, 'http://192.168.1.10:3100', label)
    assert.match(payload.text.content, /^转译任务待办\n/)
    assert.ok(payload.text.content.includes(`应用：${label}\n`))
    assert.match(payload.text.content, /当前环节：提测\n/)
    assert.ok(!payload.text.content.includes(appId))
  }
  const device = { ...task, status: 'harness_waiting', stage: 'device' }
  assert.match(notificationPayload(device, notificationState(device)!, { userId: 'owner' }, 'http://192.168.1.10:3100', '酷狗直播').text.content, /当前环节：设备验收/)
})

test('local review notice has an explicit next action; submitted handoff needs no second confirmation', () => {
  const pending = { ...task, status: 'awaiting_merge', handoffStatus: 'pending' }
  assert.match(notificationState(pending)!.reason, /本地复核/)
  assert.match(notificationState(pending)!.next, /确认提测/)
  assert.equal(notificationState({ ...pending, handoffStatus: 'submitted' }), null)
})

test('confirmation failure notifies once separately and becomes obsolete after successful submission', () => {
  const delivery = { codeSnapshot: { sha: 'published-sha' } }
  const pending = { ...task, status: 'awaiting_merge', handoffStatus: 'pending', harnessJson: JSON.stringify({ delivery }) }
  const failed = { ...pending, harnessJson: JSON.stringify({ delivery: { ...delivery, confirmationError: '集成记录冲突' } }) }
  const notice = notificationState(failed)!
  assert.match(notice.reason, /确认提测失败/)
  assert.match(notice.next, /重新确认提测/)
  assert.notEqual(notice.key, notificationState(pending)!.key)
  assert.equal(notice.key, notificationState({ ...failed, revision: 10 })!.key)
  assert.equal(notice.key, notificationState({ ...failed, harnessJson: JSON.stringify({ delivery: { ...delivery, confirmationError: '同一记录仍有冲突' } }) })!.key)
  assert.equal(notificationState({ ...failed, handoffStatus: 'submitted' }), null)
})
