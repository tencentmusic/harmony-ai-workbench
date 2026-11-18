import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareCaptureTransform } from './capture-transform'

test('visual normalization persists explicit native operations without changing approved regions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-capture-transform-'))
  try {
    const operations = [{ op: 'resize', width: 582, height: 1280, resample: 'lanczos' }]
    const args = await prepareCaptureTransform(root, operations)
    assert.equal(args[0], '--capture-transform')
    assert.deepEqual(JSON.parse(await readFile(args[1], 'utf8')), operations)
    assert.deepEqual(await prepareCaptureTransform(root, operations), args)
    await assert.rejects(prepareCaptureTransform(root, [{ ...operations[0], width: 583 }]), /其他/)
    await assert.rejects(prepareCaptureTransform(root, undefined), /其他/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('visual transform rejects unsafe, empty, oversized and unknown operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-capture-transform-'))
  try {
    for (const value of [null, [], [{ op: 'paint' }], [{ op: 'resize', width: 10, height: 10, resample: 'lanczos', mask: [] }],
      [{ op: 'resize', width: 10.5, height: 10, resample: 'lanczos' }], [{ op: 'resize', width: 8000, height: 8000, resample: 'lanczos' }],
      [{ op: 'crop', x: -1, y: 0, width: 10, height: 10 }], [{ op: 'resize', width: 10, height: 10, resample: 'unknown' }], Array(5).fill({ op: 'crop', x: 0, y: 0, width: 10, height: 10 })]) {
      await assert.rejects(prepareCaptureTransform(root, value), /转换/)
    }
    assert.deepEqual(await prepareCaptureTransform(root, undefined), [])
    assert.deepEqual(await prepareCaptureTransform(root, undefined), [])
    await assert.rejects(prepareCaptureTransform(root, [{ op: 'crop', x: 0, y: 0, width: 10, height: 10 }]), /其他/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
