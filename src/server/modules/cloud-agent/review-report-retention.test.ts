import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inspectCodeReview, requireCodeReview } from './code-review'
import { CODE_CHECKS } from './code-review-domain'
import type { HarnessWorkspace } from './harness'
import { sha256 } from './scoped-files'

test('persisted stale reports retain findings but cannot authorize a build, even for a passing old result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-retention-'))
  const workspace = { artifactRoot: root } as HarnessWorkspace
  const signal = new AbortController().signal
  try {
    await mkdir(path.join(root, 'code-review', 'fixture'), { recursive: true })
    for (const findings of [[], [{ severity: 'P1', path: 'Page.ets', line: 5, message: 'Preserved source finding' }]]) {
      const result = { summary: 'fixture', reviewedFiles: ['Page.ets'], checks: CODE_CHECKS.map(id => ({ id, status: 'passed', evidence: 'Page.ets:5' })), findings }
      const report = JSON.stringify({ files: ['Page.ets'], result, digest: 'old' })
      await writeFile(path.join(root, 'code-review', 'fixture', 'report.json'), report)
      await writeFile(path.join(root, 'code-review', 'current.json'), JSON.stringify({ status: 'stale', summary: 'Inputs changed', digest: 'old', reportPath: 'code-review/fixture/report.json', reportSha: sha256(report) }))
      const inspected = await inspectCodeReview(workspace, signal)
      assert.equal(inspected.status, 'stale')
      assert.equal(inspected.findings.length, findings.length)
      if (findings.length) assert.match(inspected.findings[0].message, /Preserved/)
      await assert.rejects(requireCodeReview(workspace, signal), /未通过/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
