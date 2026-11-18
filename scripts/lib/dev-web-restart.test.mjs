import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevWebRestart } from './dev-web-restart.mjs'

test('web exit restarts only the web service and leaves workers alone', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 })
  const launches = [], notices = []
  const supervisor = createDevWebRestart(service => launches.push(service.name), message => notices.push(message))
  assert.equal(supervisor.handleExit({ name: 'dev' }), true)
  t.mock.timers.tick(500)
  assert.deepEqual(launches, ['dev'])
  assert.equal(supervisor.handleExit({ name: 'harmony-cloud-agent-worker' }), false)
  assert.match(notices.join(''), /后台任务保持运行/)
  supervisor.stop()
})

test('web crash loop is bounded, stable uptime renews budget and shutdown cancels restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 })
  let launches = 0
  const notices = []
  const supervisor = createDevWebRestart(() => { launches++ }, message => notices.push(message))
  for (let i = 0; i < 5; i++) { assert.equal(supervisor.handleExit({ name: 'dev' }), true); t.mock.timers.tick(500) }
  assert.equal(launches, 3)
  assert.match(notices.join(''), /网页服务连续退出/)
  t.mock.timers.tick(60000)
  supervisor.handleExit({ name: 'dev' }); t.mock.timers.tick(500)
  assert.equal(launches, 4)
  supervisor.handleExit({ name: 'dev' }); supervisor.stop(); t.mock.timers.tick(500)
  assert.equal(launches, 4)
  assert.equal(supervisor.handleExit({ name: 'dev' }), true)
  t.mock.timers.tick(500)
  assert.equal(launches, 4)
})
