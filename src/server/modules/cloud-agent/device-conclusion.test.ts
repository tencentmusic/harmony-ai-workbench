import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { CloudHarness } from '@/contracts/cloud-agent'
import type { HarnessWorkspace } from './harness'
import { assertDeviceConclusion, canConcludeDevice, deviceConclusion } from './device-conclusion'
import { prepareDeviceConclusionDocuments } from './branch-documents'

test('device conclusion preserves gaps and binds the published report to the current build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-device-conclusion-'))
  const runDir = path.join(root, 'harness')
  await mkdir(runDir)
  const workspace: HarnessWorkspace = { identity: 'task-1', artifactRoot: root, runDir, androidRoot: root, harmonyRoot: root,
    androidPrefixes: [''], harmonyPrefixes: [''], appId: 'Live', title: '封面播放', profile: '', branch: 'feature/test', baseSha: 'a'.repeat(40),
    harmonyHeadSha: 'b'.repeat(40), materialVersion: 2 }
  const status: CloudHarness = { phase: 'build_passed', checkedAt: '', branch: '', worktree: '', runDir, reviewPackage: '', next: [],
    nodes: [
      { id: 'build_passed', label: '构建验证', status: 'passed' },
      { id: 'device_smoke_passed', label: '设备冒烟', status: 'passed' },
      { id: 'visual_parity_passed', label: '视觉验收', status: 'pending' },
      { id: 'functional_parity_passed', label: '功能验收', status: 'blocked' },
    ], blockers: [{ code: 'fixture_missing', message: '缺少真实视频身份与连续播放证据' }],
    codeReview: { status: 'passed', summary: '通过', checks: [], findings: [] } }
  try {
    const report = path.join(runDir, 'verification-report.json')
    await writeFile(report, JSON.stringify({ build: { artifact_sha256: 'c'.repeat(64) }, device: { evidence: 'real receipt' } }))
    assert.equal(canConcludeDevice(status), true)
    const conclusion = await deviceConclusion(workspace, status, false, '等待真实 fixture')
    assert.equal(conclusion.result, 'incomplete')
    assert.equal(conclusion.hapSha256, 'c'.repeat(64))
    assert.equal(conclusion.nodes.find(node => node.id === 'functional_parity_passed')?.status, 'blocked')
    await assertDeviceConclusion(workspace, conclusion, status)
    const overlay = await prepareDeviceConclusionDocuments(workspace, conclusion)
    const acceptance = overlay.files.find(file => file.name === 'device-acceptance.md')!
    assert.match(await readFile(acceptance.source, 'utf8'), /未完成.*缺失证据/)
    assert.match(await readFile(acceptance.source, 'utf8'), /真实视频身份与连续播放证据/)
    assert.equal(overlay.files.some(file => file.name === 'acceptance-report.md'), false)
    const baselineWorkspace = { ...workspace, harmonyHeadSha: undefined }
    const baselineConclusion = await deviceConclusion(baselineWorkspace, status, false, '等待真实 fixture')
    assert.equal(baselineConclusion.sourceHeadSha, workspace.baseSha)
    await assertDeviceConclusion(baselineWorkspace, baselineConclusion, status)
    await assert.rejects(assertDeviceConclusion(workspace, baselineConclusion, status), /不一致/)
    await writeFile(report, JSON.stringify({ device: { evidence: 'changed' } }))
    await assert.rejects(assertDeviceConclusion(workspace, conclusion, status), /原始报告已变化/)
    await assert.rejects(assertDeviceConclusion({ ...workspace, harmonyHeadSha: 'c'.repeat(40) }, conclusion, status), /不一致/)
    assert.equal(canConcludeDevice({ ...status, codeReview: { ...status.codeReview!, status: 'failed' } }), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
