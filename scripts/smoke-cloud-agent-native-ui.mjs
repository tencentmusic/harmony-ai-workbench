import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'
import { HARNESS_PHASES } from '../src/contracts/cloud-agent.ts'
import { saveVisualReport } from '../src/server/modules/cloud-agent/visual-report.ts'

loadWorkbenchEnv()
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL || '')) throw new Error('Local development only')
const { prisma } = await import('../src/lib/prisma.ts')
const base = 'http://127.0.0.1:3100'
const output = path.resolve('.runtime/cloud-agent-native-ui')
const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-native-ui-'))
const raw = 'hm_' + randomBytes(24).toString('hex')
let token, task, browser, page
try {
  await mkdir(output, { recursive: true })
  token = await prisma.apiToken.create({ data: { personName: '原生报告隔离自测', personCode: 'native-ui-smoke', tokenHash: createHash('sha256').update((process.env.TOKEN_PEPPER || '') + raw).digest('hex'), expiresAt: new Date(Date.now() + 15 * 60000) } })
  await prisma.apiTokenAppScope.create({ data: { tokenId: token.id, appScopeId: 'KugouLive' } })
  const workspace = { continuous: true, runtimeVersion: 1, materialVersion: 1, artifactRoot: root, runDir: path.join(root, 'harness'), branch: 'feature/synthetic-native-ui', targetBranch: 'kan-fx-release' }
  const directory = path.join(root, 'execution/visual')
  await mkdir(directory, { recursive: true }); await mkdir(workspace.runDir)
  const comparison = path.join(root, 'execution/comparison.json'), contents = '{"status":"failed","state":"default"}'
  const hash = createHash('sha256').update(contents).digest('hex')
  await writeFile(comparison, contents)
  await writeFile(path.join(directory, 'artifacts.json'), JSON.stringify({ state_id: 'default', comparison_report_sha256: hash }))
  await writeFile(path.join(directory, 'diff.png'), await sharp({ create: { width: 600, height: 300, channels: 3, background: '#269c78' } }).png().toBuffer())
  await writeFile(path.join(directory, 'index.html'), '<html><head><title>离线视觉差异报告</title><style>body{font:16px sans-serif;margin:20px}img{max-width:100%}</style></head><body><h1>离线视觉差异报告</h1><p>合成对照，不代表真实 App 验收通过。</p><img src="diff.png"><script>window.reportUnsafe=true</script></body></html>')
  const verification = { visual: { states: [{ id: 'default', automatic_check: { evidence: { path: comparison, sha256: hash } } }] } }
  await writeFile(path.join(workspace.runDir, 'verification-report.json'), JSON.stringify(verification))
  await saveVisualReport(workspace, 'default', { comparison_report: comparison, visual_artifacts: { status: 'generated', index: path.join(directory, 'index.html') } })
  const harness = { phase: 'build_passed', checkedAt: new Date().toISOString(), nodes: HARNESS_PHASES.map(([id, label], i) => ({ id, label, status: i <= 7 ? 'passed' : 'pending' })), blockers: [], next: [], reviewPackage: '',
    continuation: { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'complete_visual_comparison_or_record_existing_decision', owner: 'agent', reason: '检查当前视觉差异', condition: '', scenarios: ['default'] }], blocked: [{ action: 'device', owner: 'external', reason: '合成账号尚未提供', condition: '补充测试账号', scenarios: ['account'] }] },
    acceptance: { configured: true, exhausted: false, pendingIssues: [], closeoutMissing: ['configuration'] } }
  task = await prisma.cloudAgentTask.create({ data: { creatorId: token.id, appId: 'KugouLive', title: '原生报告隔离验收', material: 'SYNTHETIC ONLY', targetBranch: 'kan-fx-release', status: 'harness_waiting', stage: 'device', harnessJson: JSON.stringify({ workspace, status: harness }) } })
  const endpoint = base + '/api/cloud-agent/tasks/' + task.id + '/visual-reports'
  assert.equal((await fetch(endpoint)).status, 401)
  const headers = { authorization: 'Bearer ' + raw }
  const listing = await (await fetch(endpoint, { headers })).json()
  assert.equal(listing.reports.length, 1)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(value => { if (window === window.top) localStorage.setItem('hm_token', value) }, raw)
  await context.route('**/api/cloud-agent/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
  page = await context.newPage(); page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/dashboard?tab=cloud-agent', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(task.id)
  await page.getByRole('button', { name: task.title, exact: true }).click()
  await page.getByRole('navigation', { name: '当前任务流程' }).getByRole('button', { name: /设备验收/ }).click()
  await page.getByText('执行计划与待办', { exact: false }).click()
  await page.getByText('合成账号尚未提供', { exact: false }).waitFor()
  const iframe = page.locator('iframe[title="视觉差异 HTML 报告"]')
  await iframe.waitFor(); assert.equal(await iframe.getAttribute('sandbox'), '')
  const frame = page.frameLocator('iframe[title="视觉差异 HTML 报告"]')
  await frame.getByRole('heading', { name: '离线视觉差异报告' }).waitFor()
  await frame.locator('img').evaluate(img => img.decode())
  assert.equal(await frame.locator('img').evaluate(img => img.naturalWidth), 600)
  assert.equal(await frame.locator('body').evaluate(() => window.reportUnsafe), undefined)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await iframe.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: path.join(output, `native-report-${width}.png`), animations: 'disabled' })
  }
  verification.visual.states[0].automatic_check.evidence.sha256 = 'b'.repeat(64)
  await writeFile(path.join(workspace.runDir, 'verification-report.json'), JSON.stringify(verification))
  assert.equal((await (await fetch(endpoint, { headers })).json()).reports.length, 0)
  assert.equal((await fetch(endpoint + '?digest=' + listing.reports[0].digest, { headers })).status, 404)
  // Historical running snapshots must not look live after a worker stops.
  harness.phase = 'wired'
  harness.nodes = HARNESS_PHASES.map(([id, label], i) => ({ id, label, status: i <= 6 ? 'passed' : 'pending' }))
  harness.codeReview = { status: 'running', summary: '独立只读审查中', round: 3, elapsedMs: 420000, checks: [], findings: [{ issueId: 'R-1234567890abcdef', severity: 'P1', path: 'entry/Main.ets', line: 12, message: '合成问题，验证暂停后仍保留' }] }
  await prisma.cloudAgentTask.update({ where: { id: task.id }, data: { stage: 'review', harnessJson: JSON.stringify({ workspace, status: harness }) } })
  const detail = await (await fetch(base + '/api/cloud-agent/tasks/' + task.id, { headers })).json()
  assert.ok(JSON.stringify(detail).includes('独立审查已中断'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(task.id)
  await page.getByRole('button', { name: task.title, exact: true }).click()
  await page.getByRole('navigation', { name: '当前任务流程' }).getByRole('button', { name: /代码审查/ }).click()
  const reviewPanel = page.getByRole('article', { name: '代码审查报告' })
  await reviewPanel.getByText(/本批次第 3 轮/).waitFor()
  assert.ok((await reviewPanel.innerText()).includes('合成问题'))
  assert.ok(!(await reviewPanel.innerText()).includes('审查中'))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await reviewPanel.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: path.join(output, `review-paused-${width}.png`), animations: 'disabled' })
  }
  const recovery = await prisma.cloudAgentRun.create({ data: { taskId: task.id, revision: 1, kind: 'translation', status: 'recovery_required', input: '', leaseToken: 'synthetic', leaseUntil: new Date(0), error: '合成中断：记录写入未确认' } })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(task.id)
  await page.getByRole('button', { name: task.title, exact: true }).click()
  await page.getByText('执行中断，等待管理员恢复', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '继续 Harness', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '继续分析', exact: true }).count(), 0)
  await page.screenshot({ path: path.join(output, 'recovery-required.png'), animations: 'disabled' })
  await prisma.cloudAgentRun.update({ where: { id: recovery.id }, data: { status: 'failed', error: '合成恢复完成' } })
  await prisma.cloudAgentEvent.create({ data: { taskId: task.id, runId: recovery.id, kind: 'recovered', message: '合成恢复完成' } })
  await page.getByRole('button', { name: '继续 Harness', exact: true }).waitFor()
  // Synthetic API snapshots exercise clocks without scheduling a real worker.
  let progressState = 'review'
  const clockStart = Date.now() - 20000
  await page.route(`**/api/cloud-agent/tasks/${task.id}`, async route => {
    const response = await route.fetch(), payload = await response.json(), value = payload.item
    value.status = progressState === 'paused' ? 'harness_waiting' : 'translating'
    value.stage = 'review'
    value.runs[0] = { ...value.runs[0], createdAt: new Date(clockStart - 1000).toISOString(), status: progressState === 'paused' ? 'failed' : 'running', error: progressState === 'paused' ? '合成暂停' : null, finishedAt: new Date(clockStart + 30000).toISOString() }
    value.harness.codeReview = { ...harness.codeReview, round: 2, status: progressState === 'review' ? 'running' : 'failed', startedAt: new Date(clockStart).toISOString(), completedAt: progressState === 'review' ? undefined : new Date(clockStart + 10000).toISOString(), roundElapsedMs: progressState === 'review' ? undefined : 10000, elapsedMs: progressState === 'review' ? 387000 : 397000 }
    await route.fulfill({ response, json: payload })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '搜索需求' }).fill(task.id)
  await page.getByRole('button', { name: task.title, exact: true }).click()
  await reviewPanel.getByText('复审中', { exact: true }).waitFor()
  const clock = page.getByLabel('审查耗时')
  const before = await clock.innerText()
  await page.waitForFunction(value => document.querySelector('[aria-label="审查耗时"]')?.textContent !== value, before)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: path.join(output, `review-clock-${width}.png`), animations: 'disabled' })
  }
  progressState = 'repair'
  await prisma.cloudAgentEvent.create({ data: { taskId: task.id, kind: 'harness', message: '合成修复阶段' } })
  await reviewPanel.getByText('修复中', { exact: true }).waitFor()
  assert.match(await clock.innerText(), /累计审查 6分37秒/)
  progressState = 'paused'
  await prisma.cloudAgentEvent.create({ data: { taskId: task.id, kind: 'harness', message: '合成暂停阶段' } })
  await reviewPanel.getByText('已暂停', { exact: true }).waitFor()
  const frozen = await clock.innerText()
  await page.waitForTimeout(1500)
  assert.equal(await clock.innerText(), frozen)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, screenshots: output, checks: ['authenticated report API', 'native pending/blocked details', 'hash-bound local images', 'sandbox scripts disabled', 'desktop/mobile no overflow', 'stale comparison hidden'] }))
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  if (browser) await browser.close()
  if (task) {
    await prisma.cloudAgentEvent.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentRun.deleteMany({ where: { taskId: task.id } })
    await prisma.cloudAgentTask.delete({ where: { id: task.id } })
  }
  if (token) { await prisma.apiTokenAppScope.deleteMany({ where: { tokenId: token.id } }); await prisma.apiToken.delete({ where: { id: token.id } }) }
  await prisma.$disconnect()
  await rm(root, { recursive: true, force: true })
}
