import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

// --hmr waits for temporary, manually applied probes; see the HMR repair plan.
loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const id = process.argv[2]
if (!id) throw new Error('Pass an existing task awaiting UI approval')
const interactive = process.argv.includes('--hmr')
const base = 'http://127.0.0.1:3100'
const output = path.resolve('.runtime/cloud-agent-hmr-verified')
const rootSelector = '[class*="CloudAgent_root__"]'
const { prisma } = await import('../src/lib/prisma.ts')
let token, browser, page
try {
  await mkdir(output, { recursive: true })
  const before = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id }, include: { approvals: true } })
  assert.equal(before.status, 'awaiting_approval')
  assert.equal(JSON.parse(before.harnessJson).review.kind, 'ui')
  const raw = 'hm_' + randomBytes(24).toString('hex')
  console.log('Preparing isolated browser')
  token = await prisma.apiToken.create({ data: { personName: 'HMR只读自测', personCode: 'hmr-readonly', tokenHash: createHash('sha256').update((process.env.TOKEN_PEPPER || '') + raw).digest('hex'), expiresAt: new Date(Date.now() + 20 * 60000) } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: before.appId } })
  // Compile the asset route before testing HMR; cold dev compilation can exceed the UI's request timeout.
  const review = JSON.parse(before.harnessJson).review
  const prototype = review.files.find(file => file.label.startsWith('prototypes/'))
  assert.ok(prototype, 'Task needs an HTML prototype')
  const warmup = await fetch(`${base}/api/cloud-agent/tasks/${id}/review-file?${new URLSearchParams({ digest: review.digest, file: prototype.id, preview: 'html' })}`, { headers: { authorization: 'Bearer ' + raw }, signal: AbortSignal.timeout(180000) })
  assert.equal(warmup.status, 200)
  await warmup.arrayBuffer()
  console.log('Asset route ready')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1780, height: 1050 } })
  await context.addInitScript(value => { if (window === window.top) localStorage.setItem('hm_token', value) }, raw)
  let attemptedWrites = 0, taskRequests = 0
  await context.route('**/api/cloud-agent/**', route => {
    taskRequests++
    if (['GET', 'HEAD'].includes(route.request().method())) return route.continue()
    attemptedWrites++
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  const errors = [], cssFailures = [], updates = [], snapshots = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (/hydration|hydrated|didn't match|server rendered HTML/i.test(message.text())) errors.push(message.text())
    if (message.text().includes('[Fast Refresh]')) { updates.push(message.text()); console.log(message.text()) }
  })
  page.on('requestfailed', request => { if (request.resourceType() === 'stylesheet') cssFailures.push(request.url()) })
  page.on('response', response => { if (response.request().resourceType() === 'stylesheet' && response.status() >= 400) cssFailures.push(response.url()) })
  await page.goto(base + '/dashboard?tab=knowledge', { waitUntil: 'domcontentloaded', timeout: 60000 })
  console.log('Dashboard loaded')
  await page.locator('[class*="KnowledgeBrowser_"]').first().waitFor()
  await page.getByRole('button', { name: '转译台', exact: true }).waitFor()
  assert.equal(await page.locator(rootSelector).count(), 0)
  assert.equal(taskRequests, 0, 'Loading styles must not mount CloudAgent in the background')
  const sentinel = randomBytes(12).toString('hex')
  await page.evaluate(value => { window.__hmrSentinel = value }, sentinel)
  async function openTask() {
    console.log('Opening task')
    await page.getByRole('button', { name: '转译台', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索需求' }).fill(id)
    await page.getByRole('button', { name: before.title, exact: true }).click()
    await page.getByRole('region', { name: 'UI 基线审核', exact: true }).waitFor()
  }
  async function verify(name, mobile = false) {
    console.log('Verifying', name)
    // Fast Refresh reruns effects, so allow the selected task to finish reloading.
    await page.getByRole('region', { name: 'UI 基线审核', exact: true }).waitFor()
    const facts = await page.evaluate(selector => {
      const style = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo)
      const root = style(selector)
      const sheets = [...document.styleSheets].filter(sheet => {
        try { return [...sheet.cssRules].some(rule => rule.cssText.includes('CloudAgent_root__')) } catch { return false }
      }).map(sheet => sheet.href)
      return {
        root: root.display, direction: root.flexDirection,
        workspace: style('[class*="CloudAgent_workspace__"]').display,
        flow: style('[class*="CloudAgent_taskFlow__"]').display,
        line: style('[class*="CloudAgent_taskFlow__"] button', '::after').height,
        review: style('[class*="HarnessReview_layout__"]').display,
        footer: style('[class*="HarnessReview_footer__"]').display,
        overflow: document.documentElement.scrollWidth > innerWidth,
        sentinel: window.__hmrSentinel, sheets,
      }
    }, rootSelector)
    assert.equal(facts.root, 'flex')
    assert.equal(facts.direction, 'column')
    assert.equal(facts.workspace, 'grid')
    assert.equal(facts.flow, 'flex')
    assert.equal(facts.line, '2px')
    assert.equal(facts.review, 'grid')
    assert.equal(facts.footer, 'grid')
    assert.equal(facts.overflow, false)
    assert.equal(facts.sentinel, sentinel, 'No full page reload during HMR or menu switches')
    assert.ok(facts.sheets.some(href => href?.includes('/app/dashboard/page.css')), 'Dashboard must own CloudAgent styles')
    const frame = page.getByRole('region', { name: 'UI 基线审核', exact: true }).locator('iframe')
    await frame.waitFor()
    const child = await (await frame.elementHandle()).contentFrame()
    await child.waitForFunction(() => document.images.length > 0 && [...document.images].every(img => img.complete && img.naturalWidth > 0))
    await page.screenshot({ path: path.join(output, name + '.png') })
    snapshots.push({ name, ...facts })
    console.log('PASS', name, JSON.stringify(facts))
  }
  async function probe(attribute, expected) {
    await page.waitForFunction(({ selector, attribute, expected }) => {
      const element = document.querySelector(selector)
      return element && (attribute === 'css' ? getComputedStyle(element).getPropertyValue('--hmr-probe').trim() : element.getAttribute('data-hmr-probe')) === expected
    }, { selector: rootSelector, attribute, expected }, { timeout: 180000 })
  }
  await openTask()
  await verify('baseline')
  if (interactive) {
    console.log('READY: add data-hmr-probe="tsx" to CloudAgent root')
    await probe('attribute', 'tsx')
    await verify('tsx-update')
    console.log('READY: add .root { --hmr-probe: visible; } to CloudAgent.module.css')
    await probe('css', 'visible')
    await verify('css-update')
    console.log('READY: remove TSX probe')
    await probe('attribute', null)
    await verify('tsx-restored')
    await page.getByRole('button', { name: 'AI员工', exact: true }).click()
    await page.locator(rootSelector).waitFor({ state: 'detached' })
    const count = updates.length
    console.log('READY: change CSS probe to hidden (while CloudAgent is unmounted)')
    const deadline = Date.now() + 180000
    while (!updates.slice(count).some(message => message.includes('done'))) {
      if (Date.now() > deadline) throw new Error('Offscreen hot update timed out')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    await openTask()
    await probe('css', 'hidden')
    await verify('offscreen-update-return')
    console.log('READY: remove CSS probe')
    await probe('css', '')
    await verify('css-restored')
  }
  for (let index = 0; index < 3; index++) {
    await page.getByRole('button', { name: 'AI员工', exact: true }).click()
    await page.locator(rootSelector).waitFor({ state: 'detached' })
    await openTask()
    await verify('menu-return-' + index)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await verify('mobile', true)
  assert.deepEqual(errors, [])
  assert.deepEqual(cssFailures, [])
  assert.equal(attemptedWrites, 0)
  const after = await prisma.cloudAgentTask.findUniqueOrThrow({ where: { id }, include: { approvals: true } })
  assert.equal(after.revision, before.revision)
  assert.equal(after.status, before.status)
  assert.equal(after.harnessJson, before.harnessJson)
  assert.deepEqual(after.approvals, before.approvals)
  console.log(JSON.stringify({ passed: true, interactive, checkpoints: snapshots.length, updates, errors, cssFailures, attemptedWrites, revision: after.revision, output }))
} catch (error) {
  console.error(error)
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 10000 }).catch(() => {})
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
