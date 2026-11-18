import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { HarnessWorkspace } from './harness'
import { buildOutputRoot } from './build-output'
import { parseExecutionConfig } from './execution-config'

test('package output root is independent from external build cache', () => {
  const build = { cwd: '.', artifact: 'app.hap', command: [process.execPath, 'hvigorw.js'], cache_root: os.tmpdir() }
  assert.equal(parseExecutionConfig({ build }).build?.outputRoot, 'worktree')
  assert.equal(parseExecutionConfig({ build: { ...build, output_root: 'cache' } }).build?.outputRoot, 'cache')
  assert.throws(() => parseExecutionConfig({ build: { ...build, output_root: 'other' } }))
  assert.throws(() => parseExecutionConfig({ build: { ...build, output_root: ['cache'] } }))
  assert.throws(() => parseExecutionConfig({ build: { ...build, cache_root: undefined, output_root: 'cache' } }))
})

test('cache config rejects drive roots, relative paths and shell control characters', () => {
  const build = { cwd: '.', artifact: 'app.hap', command: [process.execPath, 'hvigorw.js'] }
  for (const cache_root of ['relative/cache', path.parse(process.cwd()).root, os.tmpdir() + '\n']) assert.throws(() => parseExecutionConfig({ build: { ...build, cache_root } }))
  assert.equal(parseExecutionConfig({ build: { ...build, cache_root: os.tmpdir() } }).build?.cacheRoot, os.tmpdir())
})

test('build output directories are task-isolated, owned and separate from source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'build-output-'))
  try {
    const source = path.join(root, 'source'), second = path.join(root, 'source-2'), cache = path.join(root, 'cache')
    await mkdir(source); await mkdir(second)
    const w = { harmonyRoot: source, identity: 'task-one' } as HarnessWorkspace
    assert.equal(await buildOutputRoot(w), source)
    const first = await buildOutputRoot(w, cache)
    assert.equal(await buildOutputRoot(w, cache), first)
    assert.notEqual(await buildOutputRoot({ ...w, harmonyRoot: second, identity: 'task-two' }, cache), first)
    await assert.rejects(buildOutputRoot({ ...w, identity: 'wrong-owner' }, cache), /归属/)
    await assert.rejects(buildOutputRoot(w, root), /分离/)
    await assert.rejects(buildOutputRoot(w, path.join(source, 'build-cache')), /分离/)
    await writeFile(path.join(first, 'owner.json'), '{}')
    await assert.rejects(buildOutputRoot(w, cache), /归属/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
