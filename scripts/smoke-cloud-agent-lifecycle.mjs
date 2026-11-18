import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const id = process.argv[2]
if (!id) throw new Error('Pass an existing translation task ID')
const { prisma } = await import('../src/lib/prisma.ts')
const output = path.resolve('.runtime/cloud-agent-lifecycle-verified')
let token, browser
try {
  const task = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id } })
  const raw = 'hm_' + randomBytes(24).toString('hex')
  token = await prisma.apiToken.create({ data: { personName: '阶段展示只读自测', personCode: 'lifecycle-readonly', tokenHash: createHash('sha256').update((process.env.TOKEN_PEPPER || '') + raw).digest('hex'), expiresAt: new Date(Date.now() + 15 * 60000) } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: task.appId } })
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await context.addInitScript(value => localStorage.setItem('hm_token', value), raw)
  let writes = 0
  await context.route('**/api/cloud-agent/**', route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.continue()
    writes++
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (/hydration|hydrated|didn't match/i.test(msg.text())) errors.push(msg.text()) })
  await page.goto('http://localhost:3100/dashboard?tab=cloud-agent', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(id)
  await page.getByRole('button', { name: task.title }).click()
  const progress = page.getByRole('region', { name: '当前阶段返修进度' })
  await progress.waitFor()
  const flow = page.getByRole('navigation', { name: '当前任务流程' })
  await flow.getByRole('button', { name: '构建验证 进行中', exact: true }).waitFor()
  assert.match(await progress.innerText(), /构建验证/)
  await page.screenshot({ path: path.join(output, 'desktop.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(id)
  await page.getByRole('button', { name: task.title }).click()
  await progress.waitFor()
  assert.match(await progress.innerText(), /构建验证/)
  await page.setViewportSize({ width: 390, height: 844 })
  await progress.scrollIntoViewIfNeeded()
  const dimensions = await page.evaluate(() => {
    const root = document.querySelector('[aria-label="当前阶段返修进度"]')
    const active = document.querySelector('[aria-label="当前任务流程"] [data-node="build"]').getBoundingClientRect()
    return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth, contentWidth: root.scrollWidth, availableWidth: root.clientWidth, activeLeft: active.left, activeRight: active.right }
  })
  assert.ok(dimensions.pageWidth <= dimensions.viewport, JSON.stringify(dimensions))
  assert.ok(dimensions.contentWidth <= dimensions.availableWidth, JSON.stringify(dimensions))
  assert.ok(dimensions.activeLeft >= 0 && dimensions.activeRight <= dimensions.viewport, JSON.stringify(dimensions))
  await page.screenshot({ path: path.join(output, 'mobile.png') })
  assert.deepEqual(errors, [])
  assert.equal(writes, 0)
  console.log(JSON.stringify({ verified: true, desktop: '1440x960', mobile: '390x844', reload: true, taskWrites: writes, output }))
} finally {
  await browser?.close()
  if (token) {
    await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
    await prisma.apiToken.delete({ where: { id: token.id } })
  }
  await prisma.$disconnect()
}
