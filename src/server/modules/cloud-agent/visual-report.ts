import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { prisma } from '@/lib/prisma'
import type { HarnessWorkspace } from './harness'
import type { NativeReview } from './harness-review'
import type { CloudActor } from './http'
import { CloudError, record } from './domain'
import { scopedPath, sha256, relativeToRoot } from './scoped-files'
import { buildReviewPreview, readReviewBytes } from './review-preview'

interface VisualReport { stateId: string; digest: string; comparison: { path: string; sha256: string }; files: NativeReview['files'] }
export async function saveVisualReport(workspace: HarnessWorkspace, state: string, value: unknown) {
  if (!/^[\w-]{1,100}$/.test(state)) throw new CloudError('视觉状态非法')
  const output = record(value), visual = record(output.visual_artifacts || {})
  if (visual.status !== 'generated' || typeof visual.index !== 'string' || typeof output.comparison_report !== 'string') return
  const resolve = async (file: string) => scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, file), ['execution'])
  const index = await resolve(visual.index), comparisonFile = await resolve(output.comparison_report)
  const comparison = { path: comparisonFile, sha256: sha256(await readFile(comparisonFile)) }
  const metadata = record(JSON.parse(await readFile(await resolve(path.join(path.dirname(index), 'artifacts.json')), 'utf8')))
  if (metadata.comparison_report_sha256 !== comparison.sha256 || metadata.state_id !== state) throw new CloudError('视觉报告来源不匹配', 409)
  const files: NativeReview['files'] = []
  for (const name of await readdir(path.dirname(index))) {
    if (!/^(index\.html|[\w-]+\.png)$/.test(name)) continue
    const file = await resolve(path.join(path.dirname(index), name)), bytes = await readFile(file)
    if (bytes.length > 12 * 1024 * 1024 || files.length > 64) throw new CloudError('视觉报告过大', 413)
    files.push({ id: name, label: name === 'index.html' ? 'visual-report' : name, path: file, sha256: sha256(bytes), mime: name.endsWith('.png') ? 'image/png' : 'text/html' })
  }
  const report = { stateId: state, comparison, files, digest: sha256(JSON.stringify({ comparison, files })) }
  const directory = await scopedPath(workspace.artifactRoot, 'visual-reports', ['visual-reports'], true)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${state}.json`), JSON.stringify(report))
}
export async function listVisualReports(workspace: HarnessWorkspace) {
  const directory = await scopedPath(workspace.artifactRoot, 'visual-reports', ['visual-reports'], true)
  const reports: VisualReport[] = []
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (!names.length) return reports
  const verificationPath = await scopedPath(workspace.artifactRoot, path.relative(workspace.artifactRoot, path.join(workspace.runDir, 'verification-report.json')).replaceAll('\\', '/'), [''])
  const verification = record(JSON.parse(await readFile(verificationPath, 'utf8')))
  const states = record(verification.visual || {}).states
  for (const name of names.filter(name => /^[\w-]{1,100}\.json$/.test(name)).slice(0, 100)) {
    try {
      const file = await scopedPath(workspace.artifactRoot, `visual-reports/${name}`, ['visual-reports'])
      const report = JSON.parse(await readFile(file, 'utf8')) as VisualReport
      if (!Array.isArray(report.files) || report.digest !== sha256(JSON.stringify({ comparison: report.comparison, files: report.files }))) continue
      const current = Array.isArray(states) ? states.map(record).find(state => state.id === report.stateId) : undefined
      const binding = record(record(current?.automatic_check || {}).evidence || {})
      if (binding.sha256 !== report.comparison.sha256 || typeof binding.path !== 'string') continue
      const bound = await scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, binding.path), ['execution'])
      const comparison = await scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, report.comparison.path), ['execution'])
      if (bound !== comparison) continue
      if (sha256(await readFile(comparison)) !== report.comparison.sha256) continue
      reports.push(report)
    } catch { /* Optional missing reports never affect quality gates. */ }
  }
  return reports
}
export async function visualReportResponse(actor: CloudActor, id: string, url: URL) {
  const task = await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } } })
  if (!task) throw new CloudError('任务不存在或无权限', 404)
  const workspace = record(JSON.parse(task.harnessJson)).workspace as HarnessWorkspace | undefined
  if (!workspace) return Response.json({ reports: [] })
  const reports = await listVisualReports(workspace)
  if (!url.searchParams.has('digest')) return Response.json({ reports: reports.map(({ stateId, digest }) => ({ stateId, digest })) }, { headers: { 'cache-control': 'no-store' } })
  const report = reports.find(r => r.digest === url.searchParams.get('digest'))
  if (!report) throw new CloudError('视觉报告不存在或已更新', 404)
  const file = report.files.find(f => f.label === 'visual-report')
  if (!file) throw new CloudError('视觉报告未生成', 404)
  const preview = await buildReviewPreview(workspace, { files: report.files } as NativeReview, file, await readReviewBytes(workspace, file))
  return Response.json(preview, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}
