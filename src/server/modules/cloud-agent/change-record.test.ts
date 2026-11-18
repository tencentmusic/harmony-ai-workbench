import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, link, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveChangePaths } from './change-record'

test('change paths bind to task source root without altering hashes, symbols or caller payload', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-change-paths-')))
  try {
    const source = path.join(root, 'entry.ets')
    await writeFile(source, 'class Entry {}')
    const proof = { path: 'entry.ets', locator: 'entry.ets#Entry', sha256: 'unchanged' }
    const input = { changes: [{ files: [{ ...proof, path: source }] }], reachability: [{ proof: { entry: proof } }] }
    const expected = { ...proof, path: source }
    assert.deepEqual(await resolveChangePaths(root, input), { changes: [{ files: [expected] }], reachability: [{ proof: { entry: expected } }] })
    assert.equal(proof.path, 'entry.ets')
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, '.git', 'config'), 'metadata')
    await link(source, path.join(root, 'alias.ets'))
    for (const unsafe of ['../outside.ets', path.join(root, '..', 'outside.ets'), '.git/config', 'alias.ets']) {
      await assert.rejects(resolveChangePaths(root, { reachability: [{ proof: { entry: { ...proof, path: unsafe } } }] }))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
