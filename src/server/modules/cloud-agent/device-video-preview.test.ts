import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readRuntimeObservation } from './native-runtime'
import { sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'

test('recorded MP4 is previewed on demand with bound frames, never decoded as text or accepted as PASS', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'device-video-preview-'))
  const runDir = path.join(root, 'harness'), runtime = path.join(runDir, '.harness-runtime')
  await mkdir(runtime, { recursive: true })
  const workspace = { artifactRoot: root, runDir } as HarnessWorkspace
  try {
    const file = path.join(runtime, 'recording.mp4')
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=4', '-t', '2', '-pix_fmt', 'yuv420p', file], { windowsHide: true, timeout: 30000 })
    const original = await readFile(file), hash = sha256(original)
    const args = { path: 'recording.mp4', sha256: hash }
    const metadata = await readRuntimeObservation(workspace, args)
    const first = metadata.content[0]
    assert.equal(first.type, 'text')
    const value = JSON.parse(first.type === 'text' ? first.text : '{}')
    assert.equal(value.previewOnly, true)
    assert.equal(value.video.duration, 2)
    assert.equal(metadata.content.length, 1)
    const result = await readRuntimeObservation(workspace, { ...args, timestamps: [0, 1] })
    const images = result.content.filter(row => row.type === 'image')
    assert.equal(images.length, 2)
    const frames = result.content.filter(row => row.type === 'text').slice(1).map(row => JSON.parse(row.text))
    assert.deepEqual(frames.map(frame => frame.timestamp), [0, 1])
    for (const frame of frames) {
      assert.equal(frame.sourceSha256, hash)
      assert.equal(sha256(await readFile(frame.path)), frame.sha256)
      assert.equal(frame.previewOnly, true)
    }
    assert.equal(sha256(await readFile(file)), hash)
    await assert.rejects(readRuntimeObservation(workspace, { ...args, timestamps: [2] }), /时间/)
    await assert.rejects(readRuntimeObservation(workspace, { ...args, timestamps: Array(9).fill(0) }), /时间/)
    await assert.rejects(readRuntimeObservation(workspace, { ...args, sha256: '0'.repeat(64) }), /摘要|变化/)
    await assert.rejects(readRuntimeObservation(workspace, { ...args, path: '../../../outside.mp4' }))
    await writeFile(file, 'tampered')
    await assert.rejects(readRuntimeObservation(workspace, args), /摘要|变化/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
