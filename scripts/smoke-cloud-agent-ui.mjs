import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { HARNESS_PHASES } from '../src/contracts/cloud-agent.ts'

loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const url = new URL(process.env.CLOUD_SMOKE_URL || 'http://127.0.0.1:3100')
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Loopback only')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const { prisma } = await import('../src/lib/prisma.ts')
const rawToken = 'hm_' + randomBytes(24).toString('hex')
const token = await prisma.apiToken.create({ data: { personName: '云Agent本地验收', personCode: 'cloud-ui-smoke', tokenHash: createHash('sha256').update((process.env.TOKEN_PEPPER || '') + rawToken).digest('hex'), expiresAt: new Date(Date.now() + 15 * 60000) } })
const auth = { authorization: 'Bearer ' + rawToken }
const outputDir = path.resolve('.runtime/cloud-agent-ui')
let task, browser, fixtureDir, page
let approvals = 0
try {
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'KugouLive' } })
  const review = { kind: 'scope', digest: 'c'.repeat(64), materialVersion: 1, content: ['需求摘要', '范围与排除项', '业务规则', '双端差异', '状态与效果', '验收范围', '风险与待确认', '证据索引'].map(title => '## ' + title + '\n\n' + Array.from({ length: 8 }, (_, i) => (i + 1) + '. 昵称保存、失败保留输入；隔离页面测试内容。').join('\n')).join('\n\n'), decision: 'approved', files: [] }
  const workspace = { continuous: true, materialVersion: 1, branch: 'feature/cloud-ui-fixture', targetBranch: 'kan-fx-release', baseSha: 'b'.repeat(40) }
  const harness = { phase: 'evidence_ready', checkedAt: new Date().toISOString(), branch: workspace.branch, worktree: 'fixture/worktree', runDir: 'fixture/harness',
    nodes: HARNESS_PHASES.map(([id, label], index) => ({ id, label, status: index < 3 ? 'passed' : 'pending' })), blockers: [], next: [], reviewPackage: review.content }
  task = await prisma.cloudAgentTask.create({ data: { creatorId: token.id, appId: 'KugouLive', title: '个人资料迁移 · 页面隔离验收', material: '隔离材料，不执行真实任务。', targetBranch: 'kan-fx-release', status: 'awaiting_approval', stage: 'approval',
    harnessJson: JSON.stringify({ workspace, status: harness, review }), runs: { create: { revision: 1, status: 'awaiting_approval', input: 'fixture', materialSnapshot: 'original', materialVersion: 1, output: '历史产物，仅供查看。', leaseToken: 'not-running', leaseUntil: new Date(0), finishedAt: new Date() } } } })
  const endpoint = '/api/cloud-agent/tasks/' + task.id
  const update = async data => prisma.cloudAgentTask.update({ where: { id: task.id }, data: { ...data, events: { create: { kind: 'fixture', message: '页面隔离状态更新' } } } })
  const responseItem = async () => (await (await fetch(new URL(endpoint, url), { headers: auth })).json())
  assert.equal((await fetch(new URL('/api/cloud-agent/apps', url))).status, 401)
  assert.equal((await fetch(new URL('/api/cloud-agent/tasks?appId=KugouPlayer', url), { headers: auth })).status, 403)
  assert.equal((await fetch(new URL('/api/cloud-agent/tasks', url), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'KugouLive', title: 'denied', material: 'fixture', targetBranch: 'live-ktv-merge' }) })).status, 403)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(value => localStorage.setItem('hm_token', value), rawToken)
  await context.route('**/api/cloud-agent/branches?*', route => route.fulfill({ json: { items: ['kan-fx-release'] } }))
  // Never let synthetic approvals, material reanalysis, or rework reach the real worker.
  await context.route('**' + endpoint, async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const input = route.request().postDataJSON()
    if (input.action === 'approve') {
      assert.equal(input.digest, review.digest)
      assert.equal(input.reason, '')
      approvals++
      await update({ status: 'approved', stage: 'ready', harnessJson: JSON.stringify({ workspace, status: { ...harness, phase: 'ui_prototype_approved' } }) })
    } else if (input.action === 'rework') {
      assert.ok(input.reason.trim())
      await update({ status: 'harness_waiting', stage: 'coding' })
    } else throw new Error('Unexpected real mutation: ' + input.action)
    await route.fulfill({ json: await responseItem() })
  })
  await context.route('**' + endpoint + '/materials', async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const input = route.request().postDataJSON()
    assert.equal(input.reanalyze, true)
    // Use the real version/attachment validation, but do not enqueue a synthetic task.
    const response = await fetch(new URL(endpoint + '/materials', url), { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, reanalyze: false }) })
    await route.fulfill({ status: response.status, json: await response.json() })
  })
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  const errors = [], knowledgeRequests = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/knowledge/')) knowledgeRequests.push(req.url()) })
  await mkdir(outputDir, { recursive: true })
  await page.goto(new URL('/dashboard?tab=cloud-agent', url).href, { waitUntil: 'domcontentloaded', timeout: 90000 })
  const lifecycle = page.getByRole('region', { name: '全生命周期阶段分布' })
  await lifecycle.waitFor({ timeout: 60000 })
  assert.equal(await lifecycle.getByRole('button').count(), 10)
  await page.getByRole('textbox', { name: '搜索需求' }).fill(task.id)
  await page.getByRole('button', { name: task.title, exact: true }).waitFor()
  await page.screenshot({ path: path.join(outputDir, 'pipeline.png'), animations: 'disabled' })
  await page.getByRole('button', { name: task.title, exact: true }).click()
  const flow = page.getByRole('navigation', { name: '当前任务流程' })
  await flow.waitFor()
  assert.equal(await lifecycle.count(), 0)
  assert.equal(await flow.getByRole('button').count(), 9)
  const assertFlow = async () => {
    const geometry = await flow.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const circle = button.firstElementChild.getBoundingClientRect()
      const box = button.getBoundingClientRect()
      const line = getComputedStyle(button, '::after')
      return { radius: circle.width / 2, center: circle.x + circle.width / 2, cy: circle.y + circle.height / 2, content: line.content,
        start: box.x + parseFloat(line.left), end: box.x + parseFloat(line.left) + parseFloat(line.width),
        y: box.y + parseFloat(line.top) + parseFloat(line.height) / 2 }
    }))
    for (let i = 0; i < geometry.length - 1; i++) {
      const line = geometry[i], next = geometry[i + 1]
      assert.equal(line.content, '\"\"', 'every adjacent step has a connector')
      const startGap = line.start - line.center - line.radius, endGap = next.center - line.end - next.radius
      assert.ok(startGap >= -1 && startGap <= 4, 'line starts just outside circle and focus halo')
      assert.ok(endGap >= -1 && endGap <= 4, 'line reaches just outside next circle and focus halo')
      assert.ok(Math.abs(line.y - line.cy) < 1, 'line and circle share an axis')
    }
    assert.equal(geometry.at(-1).content, 'none', 'no trailing connector')
  }
  await assertFlow()
  assert.equal(await page.getByRole('dialog').count(), 0)
  const approve = page.getByRole('button', { name: '批准当前门禁', exact: true })
  await approve.waitFor()
  assert.equal(await approve.isEnabled(), true)
  const nav = page.getByRole('navigation', { name: '审核章节' })
  const body = page.getByRole('region', { name: '审核正文' })
  await nav.getByRole('button', { name: /业务规则/ }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="审核章节"] [aria-current]')?.textContent?.includes('业务规则'))
  const before = await approve.boundingBox()
  await page.getByLabel('任务详情滚动区', { exact: true }).evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.waitForFunction(() => document.querySelector('[aria-label="审核章节"] [aria-current]')?.textContent?.includes('审核附件'))
  assert.equal((await approve.boundingBox()).y, before.y)
  await nav.getByRole('button', { name: /需求摘要/ }).click()
  await page.screenshot({ path: path.join(outputDir, 'task-workspace-desktop.png'), animations: 'disabled' })
  await flow.getByRole('button', { name: /需求材料/ }).click()
  assert.equal(await flow.getByRole('button', { name: /需求材料/ }).getAttribute('data-status'), 'passed')
  assert.equal(await flow.getByRole('button', { name: /人工审核/ }).getAttribute('data-status'), 'waiting', 'view selection does not change execution state')
  await update({ title: task.title + ' · 更新' })
  await page.getByRole('heading', { name: task.title + ' · 更新', exact: true }).waitFor()
  assert.match(await flow.locator('[aria-current]').innerText(), /需求材料/)
  await flow.getByRole('button', { name: /人工审核/ }).click()
  review.digest = 'd'.repeat(64)
  review.content += '\n\n## 最新补充\n\n新版本事实。'
  await update({ harnessJson: JSON.stringify({ workspace, status: harness, review }) })
  await nav.getByRole('button', { name: /最新补充/ }).waitFor()
  assert.equal(await approve.count(), 0)
  await page.getByRole('button', { name: '查看最新审核包', exact: true }).click()
  await page.getByRole('button', { name: '补充资料或提出修改' }).click()
  await page.getByRole('textbox', { name: '补充材料', exact: true }).fill('修改草稿，仅当前页面暂存。')
  await page.getByRole('button', { name: '暂存草稿', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal((await responseItem()).item.materialVersion, 1)
  assert.equal(await approve.isDisabled(), true)
  await page.getByRole('button', { name: '补充资料或提出修改' }).click()
  assert.equal(await page.getByRole('textbox', { name: '补充材料', exact: true }).inputValue(), '修改草稿，仅当前页面暂存。')
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await approve.isEnabled(), true)
  for (const viewport of [{ width: 1800, height: 1000 }, { width: 1088, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await assertFlow()
    await approve.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page horizontal overflow')
    const b = await body.boundingBox(), a = await approve.boundingBox()
    assert.ok(b.height > 100, 'review body remains readable')
    const scroll = await page.getByLabel('任务详情滚动区', { exact: true }).boundingBox()
    assert.ok(a.y >= scroll.y + scroll.height - 1, 'footer must not overlap scroll viewport')
    await page.screenshot({ path: path.join(outputDir, 'task-workspace-' + viewport.width + '.png'), fullPage: true, animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await approve.click()
  await approve.waitFor({ state: 'hidden' })
  assert.equal(approvals, 1)
  await page.getByRole('button', { name: '开始转译', exact: true }).waitFor()
  const run = await prisma.cloudAgentRun.findFirstOrThrow({ where: { taskId: task.id } })
  await prisma.cloudAgentEvent.create({ data: { taskId: task.id, runId: run.id, kind: 'output', message: '隔离测试实时输出' } })
  await page.getByRole('button', { name: '执行过程', exact: true }).click()
  await page.getByRole('region', { name: '本轮实时过程' }).getByText('隔离测试实时输出', { exact: true }).waitFor()
  await page.getByRole('button', { name: '历史轮次', exact: true }).click()
  assert.equal(await approve.count(), 0)
  await flow.getByRole('button', { name: /代码审查/ }).click()
  const codeReview = { status: 'failed', summary: '独立代码审查报告', checks: [{ id: 'save', status: 'failed', evidence: '保存失败应保留输入' }], findings: [{ severity: 'P1', path: 'profile.ets', line: 42, message: '失败分支清空输入' }] }
  await update({ status: 'harness_waiting', stage: 'review', harnessJson: JSON.stringify({ workspace, status: { ...harness, codeReview } }) })
  await page.getByText('失败分支清空输入', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(outputDir, 'task-code-review.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '补充资料或提出修改' }).click()
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'cloud-ui-materials-'))
  const videoFile = path.join(fixtureDir, 'flow.mp4')
  execFileSync(process.env.CLOUD_AGENT_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=2', '-t', '2', '-pix_fmt', 'yuv420p', '-y', videoFile], { windowsHide: true, timeout: 30000 })
  const fixtures = [
    { name: '需求说明.md', mimeType: 'text/markdown', buffer: Buffer.from('# 需求\n补充失败处理。') },
    { name: '设计稿.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 480, height: 320, channels: 3, background: '#27a395' } }).png().toBuffer() },
    { name: '操作录屏.mp4', mimeType: 'video/mp4', buffer: await readFile(videoFile) },
  ]
  await page.getByRole('textbox', { name: '补充材料', exact: true }).fill('补充正式材料。')
  await page.getByLabel('上传需求附件').setInputFiles(fixtures)
  await page.getByRole('button', { name: '下载 操作录屏.mp4', exact: true }).waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '提交修改并重新分析', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal((await responseItem()).item.materialVersion, 2)
  await flow.getByRole('button', { name: /需求材料/ }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 需求说明.md', exact: true }).click()
  const downloaded = await downloading
  assert.equal((await readFile(await downloaded.path())).toString(), fixtures[0].buffer.toString())
  await page.getByRole('button', { name: '预览 设计稿.png', exact: true }).click()
  const image = page.getByRole('img', { name: '设计稿.png', exact: true })
  await image.evaluate(img => img.decode())
  assert.equal(await image.evaluate(img => img.naturalWidth), 480)
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: '预览 操作录屏.mp4', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1)
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await update({ status: 'running' })
  await page.getByRole('button', { name: '补充资料或提出修改' }).click()
  await page.getByText('当前仍在执行，可暂存草稿，本轮结束后再提交。').waitFor()
  assert.equal(await page.getByRole('button', { name: '提交修改并重新分析', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await update({ status: 'awaiting_merge', stage: 'integration', harnessJson: JSON.stringify({ workspace, status: harness, delivery: { code: { url: 'https://example.invalid/mr/fixture' }, codeSnapshot: { sha: 'd'.repeat(40) }, codeMerged: false } }) })
  await flow.getByRole('button', { name: /提测合入/ }).click()
  await page.getByRole('button', { name: '发起返修', exact: true }).click()
  const rework = page.getByRole('dialog')
  assert.equal(await rework.getByRole('button', { name: '进入返修' }).isDisabled(), true)
  await rework.getByRole('textbox', { name: '返修原因与验收要求' }).fill('修复失败处理')
  await rework.getByRole('button', { name: '进入返修' }).click()
  await rework.waitFor({ state: 'hidden' })
  await update({ status: 'awaiting_merge', stage: 'integration', harnessJson: JSON.stringify({ workspace, status: harness, delivery: { code: { url: 'https://example.invalid/mr/fixture' }, codeSnapshot: { sha: 'd'.repeat(40) }, codeMerged: true } }) })
  await flow.getByRole('button', { name: /提测合入/ }).click()
  await page.getByRole('button', { name: '回流知识库', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '补充资料或提出修改' }).isDisabled(), true)
  await page.getByRole('button', { name: '新增转译任务', exact: true }).click()
  await page.getByLabel('需求名称').fill('表单验收，不提交')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  assert.deepEqual(errors, [])
  assert.deepEqual(knowledgeRequests, [])
  await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } })
  assert.equal((await fetch(new URL('/api/cloud-agent/apps', url), { headers: auth })).status, 401)
  console.log(JSON.stringify({ passed: true, screenshots: outputDir, checks: ['scoped APIs', 'pipeline vs tasks', '9 evidence-based nodes', 'inline one-click review', 'scrollspy/fixed footer', 'draft blocks approval', 'updated digest', 'SSE keeps selection', 'history read-only', 'code review', 'upload/download/image/video', 'running draft only', 'rework', 'delivery permissions', 'desktop/compact/mobile'] }))
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, 'task-workspace-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  const attachments = await prisma.cloudAgentAttachment.findMany({ where: { ownerId: token.id } })
  await prisma.cloudAgentAttachment.deleteMany({ where: { ownerId: token.id } })
  const materialRoot = path.resolve(process.env.CLOUD_AGENT_MATERIAL_ROOT || 'data/cloud-agent/materials')
  for (const item of attachments) {
    assert.match(item.id, /^[a-f0-9-]{36}$/)
    await rm(path.join(materialRoot, item.id), { recursive: true, force: true })
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  if (task) {
    await prisma.cloudAgentApproval.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentEvent.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentRun.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentTask.delete({ where: { id: task.id } })
  }
  await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } })
  await prisma.docAnalyticsEvent.deleteMany({ where: { apiTokenId: token.id } })
  await prisma.apiToken.delete({ where: { id: token.id } })
  await prisma.$disconnect()
}
