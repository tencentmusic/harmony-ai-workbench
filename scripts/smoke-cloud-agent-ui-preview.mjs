import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const id = process.argv[2]
const approvedMode = process.argv.includes('--approved')
if (!id) throw new Error('Pass an existing task ID waiting for UI approval; no approvals will be performed')
const base = 'http://127.0.0.1:3100'
const { prisma } = await import('../src/lib/prisma.ts')
let token, browser, page
try {
  const before = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id }, include: { approvals: true } })
  const { approvedReviews } = await import('../src/server/modules/cloud-agent/approved-reviews.ts')
  const review = approvedMode ? (await approvedReviews(before)).find(item => item.kind === 'ui') : JSON.parse(before.harnessJson).review
  if (!approvedMode) assert.equal(before.status, 'awaiting_approval')
  assert.equal(review.kind, 'ui')
  const raw = 'hm_' + randomBytes(24).toString('hex')
  token = await prisma.apiToken.create({ data: { personName: 'UI原型只读自测', personCode: 'ui-preview-readonly', tokenHash: createHash('sha256').update((process.env.TOKEN_PEPPER || '') + raw).digest('hex'), expiresAt: new Date(Date.now() + 10 * 60000) } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: before.appId } })
  const headers = { authorization: 'Bearer ' + raw }
  const prototypes = review.files.filter(file => file.label.startsWith('prototypes/'))
  assert.ok(prototypes.length)
  for (const file of prototypes) {
    const endpoint = `${base}/api/cloud-agent/tasks/${id}/review-file?${new URLSearchParams({ digest: review.digest, file: file.id, preview: 'html' })}`
    assert.equal((await fetch(endpoint)).status, 401)
    const response = await fetch(endpoint, { headers })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.warnings.length, 0, JSON.stringify(data.warnings))
    assert.match(data.html, /data:image\/(png|jpeg|webp);base64,/)
    assert.doesNotMatch(data.html, /<script/)
    assert.ok(data.width > 0 && data.height > 0)
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1780, height: 1050 } })
  await context.addInitScript(value => { if (window === window.top) localStorage.setItem('hm_token', value) }, raw)
  let attemptedWrites = 0
  await context.route('**/api/cloud-agent/**', route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.continue()
    attemptedWrites++; return route.abort()
  })
  page = await context.newPage()
  const errors = [], externalFrameRequests = []
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (request.frame() !== page.mainFrame() && /^https?:/.test(request.url())) externalFrameRequests.push(request.url())
  })
  const output = path.resolve(approvedMode ? '.runtime/cloud-approved-ui-verified' : '.runtime/cloud-ui-preview-verified')
  await mkdir(output, { recursive: true })
  await page.goto(base + '/dashboard?tab=cloud-agent', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(id)
  await page.getByRole('button', { name: before.title, exact: true }).click()
  const flow = page.getByRole('navigation', { name: '当前任务流程' })
  async function verifySelectionFrame() {
    const selected = flow.locator('button[aria-current]')
    const geometry = await selected.evaluate(button => {
      const frame = getComputedStyle(button, '::before'), line = getComputedStyle(button, '::after')
      const icon = button.firstElementChild.getBoundingClientRect(), box = button.getBoundingClientRect()
      return { width: parseFloat(frame.width), height: parseFloat(frame.height), radius: frame.borderRadius,
        iconCenter: icon.top - box.top + icon.height / 2, lineCenter: parseFloat(line.top) + parseFloat(line.height) / 2,
        labelsFit: [...button.children].every(child => child.getBoundingClientRect().width <= parseFloat(frame.width)) }
    })
    assert.equal(geometry.width, 78); assert.equal(geometry.height, 82); assert.equal(geometry.radius, '8px')
    assert.ok(geometry.labelsFit)
    assert.ok(Math.abs(geometry.iconCenter - geometry.lineCenter) < 1)
  }
  await verifySelectionFrame()
  await flow.screenshot({ path: path.join(output, 'flow-desktop.png') })
  if (approvedMode) await page.getByRole('navigation', { name: '当前任务流程' }).getByRole('button', { name: /人工审核/ }).click()
  const reviewRegion = page.getByRole('region', { name: 'UI 基线审核', exact: true })
  if (approvedMode) {
    await reviewRegion.getByText('已审批版本 · 只读', { exact: true }).waitFor()
    assert.equal(await reviewRegion.getByRole('button', { name: '批准当前门禁', exact: true }).count(), 0)
    await page.getByText('需求范围', { exact: true }).click()
    await page.getByRole('region', { name: '范围与验收审核', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '批准当前门禁', exact: true }).count(), 0)
    await page.getByText('UI 原型', { exact: true }).click()
  } else await reviewRegion.getByRole('button', { name: '批准当前门禁', exact: true }).waitFor()
  const tabs = reviewRegion.getByRole('tablist', { name: 'UI 页面状态' }).getByRole('tab')
  assert.equal(await tabs.count(), prototypes.length)
  async function verifyFrame(locator) {
    await locator.waitFor()
    assert.equal(await locator.getAttribute('sandbox'), '')
    const frame = locator.contentFrame()
    await frame.locator('body').waitFor()
    await frame.locator('img').first().waitFor()
    const handle = await locator.elementHandle(), child = await handle.contentFrame()
    await child.waitForFunction(() => [...document.images].length > 0 && [...document.images].every(img => img.complete && img.naturalWidth > 0))
    const facts = await child.evaluate(() => ({ text: document.body.innerText, width: innerWidth, height: innerHeight, images: document.images.length, styles: getComputedStyle(document.body).margin, footer: document.querySelector('footer')?.getBoundingClientRect().bottom }))
    assert.ok(facts.text.length > 20)
    assert.ok(facts.images > 0)
    assert.ok(!facts.footer || facts.footer <= facts.height)
    const stats = await sharp(await locator.screenshot()).stats()
    assert.ok(stats.channels.some(channel => channel.stdev > 20), 'HTML preview must not be blank')
    return facts
  }
  async function verifyRender(root) {
    const image = root.locator('img[alt="原型渲染图"]')
    await image.waitFor()
    await image.evaluate(img => img.complete && img.naturalWidth > 0 ? true : new Promise((resolve, reject) => { img.addEventListener('load', () => resolve(true), { once: true }); img.addEventListener('error', () => reject(new Error('原型渲染图加载失败')), { once: true }) }))
    const facts = await image.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }))
    assert.ok(facts.width > 0 && facts.height > 0)
    return facts
  }
  const frames = []
  for (let index = 0; index < prototypes.length; index++) {
    console.log('state', index)
    await tabs.nth(index).click()
    const facts = await verifyRender(reviewRegion)
    frames.push(facts)
    await page.waitForFunction(() => [...document.querySelectorAll('img[alt="Android 基线截图"]')].some(img => img.complete && img.naturalWidth > 0))
    await reviewRegion.getByRole('navigation', { name: '审核章节' }).getByRole('button', { name: /UI 原型对照/ }).click()
    await reviewRegion.getByRole('button', { name: '放大原型', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await verifyRender(dialog)
    await dialog.screenshot({ path: path.join(output, `html-full-${index}.png`) })
    await dialog.getByText('原始尺寸', { exact: true }).click()
    await verifyRender(dialog)
    await dialog.screenshot({ path: path.join(output, `html-${index}.png`) })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await tabs.first().click()
  await verifyRender(reviewRegion)
  await reviewRegion.getByRole('navigation', { name: '审核章节' }).getByRole('button', { name: /UI 原型对照/ }).click()
  await page.screenshot({ path: path.join(output, 'desktop.png') })
  await reviewRegion.getByRole('navigation', { name: '审核章节' }).getByRole('button', { name: /审核附件/ }).click()
  await reviewRegion.getByText(`辅助资料与原始附件（${review.files.length}）`, { exact: true }).click()
  await reviewRegion.getByRole('button', { name: `HTML 原型 · ${prototypes[0].label.split('/')[1]}`, exact: true }).click()
  const attachmentDialog = page.getByRole('dialog')
  await verifyFrame(attachmentDialog.locator('iframe'))
  const download = page.waitForEvent('download')
  await attachmentDialog.getByRole('button', { name: '下载原始 HTML', exact: true }).click()
  const downloaded = await download
  assert.equal(createHash('sha256').update(await readFile(await downloaded.path())).digest('hex'), prototypes[0].sha256)
  await attachmentDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await reviewRegion.getByRole('navigation', { name: '审核章节' }).getByRole('button', { name: /UI 原型对照/ }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await verifySelectionFrame()
  await verifyRender(reviewRegion)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No outer horizontal overflow')
  await page.screenshot({ path: path.join(output, 'mobile.png') })
  await reviewRegion.getByRole('navigation', { name: '审核章节' }).getByRole('button', { name: /UI 原型对照/ }).click()
  await reviewRegion.getByRole('button', { name: '放大原型', exact: true }).click()
  await verifyRender(page.getByRole('dialog'))
  await page.screenshot({ path: path.join(output, 'mobile-full-preview.png') })
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  assert.deepEqual(errors, [])
  assert.deepEqual(externalFrameRequests, [])
  assert.equal(attemptedWrites, 0)
  const after = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id }, include: { approvals: true } })
  assert.equal(after.revision, before.revision)
  if (!approvedMode) {
    assert.equal(after.harnessJson, before.harnessJson)
    assert.equal(after.status, before.status)
  }
  assert.deepEqual(after.approvals, before.approvals)
  assert.equal(after.approvals.length, before.approvals.length)
  console.log(JSON.stringify({ passed: true, revision: before.revision, frames, errors, attemptedWrites, output }))
} catch (error) {
  await page?.screenshot({ path: '.runtime/cloud-ui-preview-verified/failure.png', fullPage: true }).catch(() => {})
  if (page) console.error('visible dialogs:', await page.getByRole('dialog').count())
  throw error
} finally {
  await browser?.close()
  if (token) {
    await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
    await prisma.docAnalyticsEvent.deleteMany({ where: { apiTokenId: token.id } })
    await prisma.apiToken.delete({ where: { id: token.id } })
  }
  await prisma.$disconnect()
}
