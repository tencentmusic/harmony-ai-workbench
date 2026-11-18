import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

// Browser-only fixtures. All API requests are intercepted, including confirmation.
const base = 'http://127.0.0.1:3100', output = path.resolve('.runtime/cloud-agent-handoff')
const now = new Date().toISOString()
const task = { id: 'handoff-fixture', appId: 'fixture', title: '首页推荐列表封面视频播放 · 交接自测', material: 'synthetic', targetBranch: 'kan-fx-release', model: 'fixture', source: 'manual', sourceUrl: null,
  status: 'awaiting_merge', stage: 'integration', revision: 1, materialVersion: 1, attachments: [], actions: ['confirm_delivery', 'cancel'], createdAt: now, updatedAt: now, runs: [],
  branch: { name: 'feature/cloud-cmumctcdy0000l8p0nvffqo9n-2', base: 'kan-fx-release' },
  harness: { phase: 'delivery_ready', nodes: ['initialized', 'context_ready', 'evidence_ready', 'scope_approved', 'ui_prototype_approved', 'implemented', 'wired', 'build_passed', 'device_smoke_passed', 'visual_parity_passed', 'functional_parity_passed', 'delivery_ready'].map(id => ({ id, status: 'passed' })), codeReview: { status: 'passed' }, blockers: [], next: [] },
  delivery: { handoff: { status: 'pending' }, frozen: true, acceptedSha: 'f71a7ef7302250e4d55c1f320f5718cd01146208', repositoryUrl: 'https://git.example/team/harmony', branch: 'feature/cloud-cmumctcdy0000l8p0nvffqo9n-2', target: 'kan-fx-release', documentsPath: 'docs/migrations/KugouLive/cmumctcdy0000l8p0nvffqo9n-2' } }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  await mkdir(output, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('hm_token', 'isolated-handoff-fixture'))
  const writes = []
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') {
      assert.equal(request.method(), 'PATCH')
      assert.equal(url.pathname, '/api/cloud-agent/tasks/handoff-fixture')
      const input = request.postDataJSON()
      writes.push(input)
      assert.equal(input.action, 'confirm_delivery')
      task.delivery.handoff = { status: 'submitted', submittedAt: now, submittedBy: '开发自测' }
      task.delivery.integrationId = 'cloud-handoff-fixture'
      task.actions = ['sync_delivery', 'cancel']
      task.updatedAt = new Date().toISOString()
      return route.fulfill({ json: { item: task } })
    }
    let json = { items: [] }
    if (url.pathname === '/api/me') json = { personName: '界面自测', personCode: 'fixture' }
    else if (url.pathname === '/api/cloud-agent/apps') json = { items: [{ id: 'fixture', label: '酷狗直播', sourceIssues: [] }] }
    else if (url.pathname === '/api/cloud-agent/tasks') json = { items: [task], total: 1, page: 1, summary: { total: 1, byStatus: {}, byStage: {} } }
    else if (url.pathname === '/api/cloud-agent/tasks/handoff-fixture') json = { item: task }
    else if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' })
    return route.fulfill({ json })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', entry => { if (/hydrated|hydration|didn't match/.test(entry.text())) errors.push(entry.text()) })
  await page.goto(base + '/dashboard?tab=cloud-agent&cloudTask=handoff-fixture', { waitUntil: 'domcontentloaded', timeout: 90000 })
  const region = page.getByRole('region', { name: '开发交接与提测' })
  await region.waitFor()
  const confirm = page.getByRole('button', { name: '已完成本地复核，确认提测', exact: true })
  assert.equal(await confirm.isEnabled(), true)
  assert.equal(await page.getByRole('link', { name: '查看提测单', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '发起返修', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '补充资料或提出修改' }).count(), 0)
  for (const [width, height] of [[1440, 900], [960, 720], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await confirm.waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const box = await confirm.boundingBox()
    assert.ok(box && box.y >= 0 && box.y + box.height <= height, 'confirmation footer remains visible')
    assert.equal(await region.evaluate(element => element.scrollWidth > element.clientWidth), false)
    await page.screenshot({ path: path.join(output, `pending-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByText('补充备注（选填）', { exact: true }).click()
  assert.equal(await page.getByRole('textbox', { name: '提测备注（选填）' }).isVisible(), true)
  await confirm.click()
  await page.getByRole('link', { name: '查看提测单', exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].reason, '')
  assert.equal(await confirm.count(), 0)
  assert.match(await page.locator('[data-node="integration"]').innerText(), /已完成/)
  assert.match(await page.locator('[data-node="knowledge"]').innerText(), /待代码合入/)
  assert.match(await page.getByRole('link', { name: '查看提测单', exact: true }).getAttribute('href'), /integrationTask=cloud-handoff-fixture/)
  await page.screenshot({ path: path.join(output, 'submitted.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await region.waitFor()
  assert.equal(await confirm.count(), 0)
  assert.deepEqual(errors, [])
  console.log('Handoff UI passed: no record before confirmation, optional empty note, single confirmation, submitted node, desktop/tablet/mobile layout, reload, no runtime/hydration errors. All API writes mocked.')
} finally { await browser.close() }
