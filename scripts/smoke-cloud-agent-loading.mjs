import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const { prisma } = await import('../src/lib/prisma.ts')
const { hashToken } = await import('../src/lib/token.ts')
const base = 'http://127.0.0.1:3100', output = path.resolve('.runtime/cloud-agent-loading')
const ids = [], suffix = randomBytes(5).toString('hex')
let browser, page, token, release
try {
  await mkdir(output, { recursive: true })
  const raw = 'hm_' + randomBytes(24).toString('hex')
  token = await prisma.apiToken.create({ data: { personName: '详情加载自测', personCode: 'loading-' + suffix, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 20 * 60000) } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'KugouLive' } })
  for (const name of ['A', 'B']) {
    const task = await prisma.cloudAgentTask.create({ data: { appId: 'KugouLive', title: `加载自测 ${suffix} ${name}`, material: '合成测试资料', targetBranch: 'kan-fx-release', status: 'cancelled', revision: 12 } })
    ids.push(task.id)
    await prisma.cloudAgentRun.createMany({ data: Array.from({ length: 12 }, (_, index) => ({ taskId: task.id, revision: index + 1, status: 'approved', input: '', output: `合成历史第 ${index + 1} 轮`, materialSnapshot: '合成材料', leaseToken: 'fixture', leaseUntil: new Date(0) })) })
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1920, height: 920 } })
  await context.addInitScript(value => { localStorage.setItem('hm_token', value) }, raw)
  page = await context.newPage(); page.setDefaultTimeout(60000)
  const errors = [], counts = { detail: 0, history: 0, writes: 0 }
  page.on('pageerror', error => errors.push(error.message))
  let holdA = true, failB = true, waiting
  const gate = () => { waiting = new Promise(resolve => { release = resolve }) }
  gate()
  await context.route('**/api/cloud-agent/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname
    if (req.method() !== 'GET') { counts.writes++; return route.abort() }
    if (pathname.endsWith('/runs')) counts.history++
    if (ids.some(id => pathname === `/api/cloud-agent/tasks/${id}`)) {
      counts.detail++
      if (pathname.endsWith(ids[0]) && holdA) await waiting
      if (pathname.endsWith(ids[1]) && failB) { failB = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟暂时不可用' }) }) }
    }
    return route.continue()
  })
  await page.goto(base + '/dashboard?tab=cloud-agent', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.getByRole('tab', { name: '任务列表', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索需求' }).fill(suffix)
  const pick = name => page.getByRole('complementary', { name: '任务列表' }).getByRole('button').filter({ hasText: `加载自测 ${suffix} ${name}` })
  await pick('A').click()
  await page.getByRole('status').filter({ hasText: '正在读取任务' }).waitFor()
  const geometry = async () => page.evaluate(() => {
    const main = document.querySelector('main[class*="CloudAgent_detail"]'), status = main.querySelector('[role="status"]')
    const a = main.getBoundingClientRect(), b = status.getBoundingClientRect()
    return { dx: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), overflow: document.documentElement.scrollWidth > innerWidth }
  })
  assert.ok((await geometry()).dy < 2, JSON.stringify(await geometry()))
  await page.screenshot({ path: path.join(output, 'loading-desktop.png') })
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('focus')) })
  await page.waitForTimeout(800)
  assert.equal(counts.detail, 1, 'same-task requests should share one network call')
  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await geometry()
  assert.ok(mobile.dy < 2 && mobile.dx < 2 && !mobile.overflow, JSON.stringify(mobile))
  await page.screenshot({ path: path.join(output, 'loading-mobile.png') })
  await page.setViewportSize({ width: 1920, height: 920 })
  holdA = false; release()
  await page.getByRole('heading', { name: `加载自测 ${suffix} A`, exact: true }).waitFor()
  assert.equal(counts.history, 0)
  await pick('B').click()
  await page.getByText('任务读取失败', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'load-error.png') })
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByRole('heading', { name: `加载自测 ${suffix} B`, exact: true }).waitFor()
  holdA = true; gate()
  await pick('A').click()
  await page.getByRole('heading', { name: `加载自测 ${suffix} A`, exact: true }).waitFor({ timeout: 2000 })
  assert.equal(await page.getByLabel('任务详情占位').count(), 0)
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page.getByRole('button', { name: '转译台', exact: true }).click()
  await page.getByRole('heading', { name: `加载自测 ${suffix} A`, exact: true }).waitFor({ timeout: 2000 })
  assert.equal(await page.getByLabel('任务详情占位').count(), 0)
  holdA = false; release()
  await page.getByRole('button', { name: '历史轮次', exact: true }).click()
  await page.getByRole('region', { name: '历史轮次记录' }).locator('details').first().waitFor()
  assert.equal(counts.history, 1)
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="历史轮次记录"] > details').length === 12)
  assert.equal(counts.history, 2)
  await page.screenshot({ path: path.join(output, 'history-desktop.png') })
  // Healthy SSE avoids the former unconditional five-second full-detail poll.
  await page.waitForTimeout(1000)
  const beforeIdle = counts.detail
  await page.waitForTimeout(5500)
  assert.equal(counts.detail, beforeIdle)
  await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('heading', { name: `加载自测 ${suffix} A`, exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('region', { name: '历史轮次记录' }).count(), 0)
  assert.equal(counts.writes, 0); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, counts, screenshots: output, checks: ['desktop/mobile centering', 'deduplication', 'retry', 'cached task/menu return', 'lazy paged history', 'healthy SSE cadence', 'permission removal clears detail'] }))
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  release?.()
  await browser?.close()
  for (const id of ids) {
    await prisma.cloudAgentEvent.deleteMany({ where: { taskId: id } })
    await prisma.cloudAgentRun.deleteMany({ where: { taskId: id } })
    await prisma.cloudAgentTask.delete({ where: { id } })
  }
  if (token) {
    await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
    await prisma.docAnalyticsEvent.deleteMany({ where: { apiTokenId: token.id } })
    await prisma.apiToken.delete({ where: { id: token.id } })
  }
  await prisma.$disconnect()
}
