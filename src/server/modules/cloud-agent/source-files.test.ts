import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, link, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { mutateSource } from './source-files'
import { readScoped, scopedPath, sha256 } from './scoped-files'

test('whole-project editing preserves large files, BOM and CRLF; supports configs, moves and deletes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-source-'))
  try {
    const text = '\ufeff' + '// unchanged\r\n'.repeat(30000) + 'oldHandler()\r\n'
    await writeFile(path.join(root, 'Large.ets'), text)
    const edited = await mutateSource(root, { operation: 'edit', path: 'Large.ets', expectedSha256: sha256(text), edits: [{ oldText: 'oldHandler()', newText: 'newHandler()' }] })
    assert.equal(await readFile(path.join(root, 'Large.ets'), 'utf8'), text.replace('oldHandler()', 'newHandler()'))
    assert.equal(edited.sha256, sha256(text.replace('oldHandler()', 'newHandler()')))
    for (const file of ['build-profile.json5', 'hvigorfile.ts', 'oh-package.json5', 'AGENTS.md', '.gitignore', '.config/settings.yaml', 'shared/player.cpp']) {
      await mutateSource(root, { operation: 'write', path: file, content: 'original\n', expectedSha256: 'new' })
      assert.equal((await readScoped(root, file, [''], 0, true)).text, 'original\n')
    }
    const moved = await mutateSource(root, { operation: 'move', path: 'shared/player.cpp', targetPath: 'common/player.cc', expectedSha256: sha256('original\n') })
    assert.equal(moved.path, 'common/player.cc')
    await assert.rejects(readFile(path.join(root, 'shared/player.cpp')), { code: 'ENOENT' })
    await mutateSource(root, { operation: 'delete', path: 'common/player.cc', expectedSha256: sha256('original\n') })
    await assert.rejects(readFile(path.join(root, 'common/player.cc')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed or racing edits do not partially apply or overwrite another edit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-source-'))
  try {
    const file = path.join(root, 'Main.ets'), original = 'unique repeated repeated'
    await writeFile(file, original)
    const edit = (edits: unknown, expectedSha256 = sha256(original)) => mutateSource(root, { operation: 'edit', path: 'Main.ets', expectedSha256, edits })
    await assert.rejects(edit([{ oldText: 'unique', newText: 'done' }, { oldText: 'missing', newText: '' }]), /匹配/)
    await assert.rejects(edit([{ oldText: 'repeated', newText: '' }]), /唯一/)
    await assert.rejects(edit([{ oldText: '', newText: 'prepend' }]), /原文/)
    await assert.rejects(edit([{ oldText: 'unique', newText: 'done' }], 'new'), /变化/)
    assert.equal(await readFile(file, 'utf8'), original)
    const results = await Promise.allSettled([edit([{ oldText: 'unique', newText: 'first' }]), edit([{ oldText: 'unique', newText: 'second' }])])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const winner = results[0].status === 'fulfilled' ? 'first' : 'second'
    const expected = original.replace('unique', winner)
    assert.equal(await readFile(file, 'utf8'), expected)
    await writeFile(path.join(root, 'occupied.ets'), 'keep')
    await assert.rejects(mutateSource(root, { operation: 'move', path: 'Main.ets', targetPath: 'occupied.ets', expectedSha256: sha256(expected) }), /存在/)
    assert.equal(await readFile(path.join(root, 'occupied.ets'), 'utf8'), 'keep')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('full project access still rejects escape, git metadata, hardlinks and directory junctions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-source-'))
  try {
    const repo = path.join(root, 'repo'), outside = path.join(root, 'outside')
    await mkdir(repo); await mkdir(outside)
    await writeFile(path.join(outside, 'target.txt'), 'keep')
    await link(path.join(outside, 'target.txt'), path.join(repo, 'hard.txt'))
    await symlink(outside, path.join(repo, 'linked'), 'junction')
    for (const file of ['../outside/target.txt', '.git', '.GIT/config', 'a/.git/config', 'git~1/config', 'linked/target.txt', 'hard.txt', 'C:/outside.txt', 'a\\..\\outside.txt']) {
      await assert.rejects(mutateSource(repo, { operation: 'write', path: file, content: 'bad', expectedSha256: 'new' }))
    }
    await assert.rejects(scopedPath(repo, '.gitignore', [''], true), /范围/)
    assert.equal(await readFile(path.join(outside, 'target.txt'), 'utf8'), 'keep')
  } finally { await rm(root, { recursive: true, force: true }) }
})
