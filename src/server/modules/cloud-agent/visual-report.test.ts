import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { saveVisualReport, listVisualReports } from './visual-report'
import { buildReviewPreview, readReviewBytes } from './review-preview'
import { sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'
import type { NativeReview } from './harness-review'

test('optional visual reports bind current comparison, reject tampering and sandbox local images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-visual-report-'))
  const workspace = { artifactRoot: root, runDir: path.join(root, 'harness') } as HarnessWorkspace
  try {
    assert.deepEqual(await listVisualReports(workspace), [])
    const directory = path.join(root, 'execution/report')
    await mkdir(directory, { recursive: true }); await mkdir(workspace.runDir)
    const comparison = path.join(root, 'execution/comparison.json')
    await writeFile(comparison, '{"status":"failed"}')
    const hash = sha256(await readFile(comparison))
    await writeFile(path.join(directory, 'artifacts.json'), JSON.stringify({ state_id: 'default', comparison_report_sha256: hash }))
    await writeFile(path.join(directory, 'index.html'), '<h1>Visual comparison</h1><img src="diff.png"><script>parent.pwned=true</script><img src="https://example.invalid/pixel"><a href="javascript:alert(1)">unsafe</a>')
    await writeFile(path.join(directory, 'diff.png'), await sharp({ create: { width: 20, height: 20, channels: 3, background: '#239570' } }).png().toBuffer())
    const verification = { visual: { states: [{ id: 'default', automatic_check: { evidence: { path: comparison, sha256: hash } } }] } }
    const vf = path.join(workspace.runDir, 'verification-report.json')
    await writeFile(vf, JSON.stringify(verification))
    await saveVisualReport(workspace, 'default', { comparison_report: comparison, visual_artifacts: { status: 'generated', index: path.join(directory, 'index.html') } })
    const reports = await listVisualReports(workspace)
    assert.equal(reports.length, 1)
    const file = reports[0].files.find(f => f.label === 'visual-report')!
    const preview = await buildReviewPreview(workspace, { files: reports[0].files } as NativeReview, file, await readReviewBytes(workspace, file))
    assert.match(preview.html, /data:image\/png/)
    assert.doesNotMatch(preview.html, /parent.pwned|javascript:alert|https:\/\/example.invalid/)
    await writeFile(path.join(directory, 'index.html'), 'changed')
    await assert.rejects(readReviewBytes(workspace, file), /变化|摘要/)
    verification.visual.states[0].automatic_check.evidence.sha256 = 'b'.repeat(64)
    await writeFile(vf, JSON.stringify(verification))
    assert.deepEqual(await listVisualReports(workspace), [])
    await assert.rejects(saveVisualReport(workspace, '../escape', {}))
    await writeFile(path.join(root, 'visual-reports/default.json'), '{broken')
    assert.deepEqual(await listVisualReports(workspace), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
