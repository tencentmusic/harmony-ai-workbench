import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inspectCandidate, readScoped, writeScoped } from './scoped-files'

test('candidate inspection supports safe creation and conflict recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-candidate-'))
  try {
    const file = 'candidates/notes.md'
    assert.deepEqual(await inspectCandidate(root, file), { relativePath: file, exists: false, expectedSha256: 'new' })
    await assert.rejects(readScoped(root, file, ['']), /文件不存在/)
    await assert.rejects(writeScoped(root, file, ['candidates'], 'a', ''), /新建文件.*new/)
    const created = await writeScoped(root, file, ['candidates'], 'a', 'new')
    const found = await inspectCandidate(root, file)
    assert.equal(found.expectedSha256, created.sha256)
    await assert.rejects(writeScoped(root, file, ['candidates'], 'b', 'new'), /重新读取/)
    const before = await readScoped(root, file, ['candidates'])
    await writeScoped(root, file, ['candidates'], 'b', before.sha256)
    assert.equal((await readScoped(root, file, ['candidates'])).text, 'b')
    await assert.rejects(inspectCandidate(root, '../outside.md'))
    await assert.rejects(inspectCandidate(root, 'harness/manifest.json'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
