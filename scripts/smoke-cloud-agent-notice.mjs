import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

// Browser-only fixtures: every API request is intercepted; no database or task writes.
const base = 'http://127.0.0.1:3100', output = path.resolve('.runtime/cloud-agent-notice')
const error = '平台检测到连续8轮没有新证据或调度变化，已保留进度；需要排查工具或模型空转，不是新增审批。artifact_read：文件不存在；harness_finalize：Harness functional_parity_passed 尚未通过'
const task = { id: 'notice-fixture', appId: 'fixture', title: '停止提示隔离自测', material: '界面验证，不执行任务', targetBranch: 'release', model: 'fixture', source: 'manual', sourceUrl: null,
  status: 'harness_waiting', revision: 1, materialVersion: 1, attachments: [], actions: ['resume_translation'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  runs: [{ id: 'notice-run', kind: 'translation', status: 'harness_waiting', error, output: '', materialVersion: 1, attachments: [], createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  await mkdir(output, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('hm_token', 'isolated-notice-fixture'))
  let writes = 0
  await context.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') { writes++; return route.abort() }
    let json = { items: [] }
    if (url.pathname === '/api/me') json = { personName: '界面自测', personCode: 'fixture' }
    else if (url.pathname === '/api/cloud-agent/apps') json = { items: [{ id: 'fixture', label: '测试项目', sourceIssues: [] }] }
    else if (url.pathname === '/api/cloud-agent/tasks') json = { items: [task], total: 1, page: 1, summary: { total: 1, byStatus: {}, byStage: {} } }
    else if (url.pathname === '/api/cloud-agent/tasks/notice-fixture') json = { item: task }
    else if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' })
    return route.fulfill({ json })
  })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  const open = async () => {
    await page.goto(base + '/dashboard?tab=cloud-agent', { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.getByRole('button', { name: task.title, exact: true }).click()
    await page.getByRole('heading', { name: task.title, exact: true }).waitFor()
  }
  await open()
  const notice = page.locator('[aria-label="任务状态提示"]')
  await notice.waitFor()
  assert.equal(await notice.count(), 1)
  assert.equal(await page.locator('[class*="CloudAgent_taskSummary"] .ant-alert').count(), 1)
  assert.equal(await notice.locator('details').evaluate(e => e.open), false)
  assert.equal(await notice.locator('pre').isVisible(), false)
  assert.match(await notice.innerText(), /下一步.*继续 Harness/)
  await page.screenshot({ path: path.join(output, 'desktop-collapsed.png') })
  await notice.locator('summary').focus()
  await page.keyboard.press('Enter')
  assert.equal(await notice.locator('pre').innerText(), error)
  await notice.locator('summary').click()
  assert.equal(await notice.locator('pre').isVisible(), false)
  await page.setViewportSize({ width: 390, height: 844 })
  await notice.scrollIntoViewIfNeeded()
  assert.equal(await notice.evaluate(e => e.scrollWidth > e.clientWidth), false)
  await page.screenshot({ path: path.join(output, 'mobile-collapsed.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  task.recoveryRequired = true
  await open()
  await page.getByText('执行中断，待管理员恢复', { exact: true }).waitFor()
  assert.equal(await notice.count(), 1)
  assert.doesNotMatch(await notice.innerText(), /继续 Harness/)
  task.recoveryRequired = false
  task.status = 'translating'
  task.actions = []
  await open()
  assert.equal(await notice.count(), 0)
  assert.equal(writes, 0)
  assert.deepEqual(errors, [])
  console.log('Notice smoke passed: single banner, collapsed full error, keyboard toggle, mobile wrapping, recovery priority, old error hidden; zero API writes.')
} finally { await browser.close() }
