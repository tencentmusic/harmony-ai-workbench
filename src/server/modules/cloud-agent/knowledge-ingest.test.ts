import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { validateKnowledgePlan, knowledgeFingerprint, withWikiSkillAlias } from './knowledge-ingest'
import { git } from './git'

test('knowledge ingest permits only canonical Markdown facts, never indexes, rules, raw Harness JSON or external drafts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-wiki-plan-'))
  try {
    await mkdir(path.join(root, '.wiki-tmp')); await mkdir(path.join(root, 'android_wiki'))
    await writeFile(path.join(root, '.wiki-tmp/page.md'), '# Fixture\n')
    const page = { action: 'create', path: 'wiki/features/module/feature/implementation.md', content_file: '.wiki-tmp/page.md' }
    const put = async (patch: Record<string, unknown> = {}) => writeFile(path.join(root, '.wiki-tmp/apply-plan.json'), JSON.stringify({ operation: 'ingest', summary: 'fixture', date: '2026-10-13', log: { kind: 'ingest', title: 'fixture' }, pages: [{ ...page, ...patch }] }))
    await put(); assert.equal((await validateKnowledgePlan(root)).pages.length, 1)
    for (const patch of [{ path: 'wiki/indexes/manifest/catalog.json' }, { path: 'wiki/features/x/manifest.json' }, { path: '../AGENTS.md' }, { path: '.agents/skills/SKILL.md' }, { action: 'delete' }, { content_file: '../outside.md' }, { raw_file: '../../external' }]) {
      await put(patch); await assert.rejects(validateKnowledgePlan(root))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('knowledge fingerprint includes new files and Windows skill alias is restored even after validation failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-wiki-fingerprint-')), signal = new AbortController().signal
  try {
    await mkdir(path.join(root, '.wiki-tmp')); await mkdir(path.join(root, '.claude')); await mkdir(path.join(root, '.agents/skills'), { recursive: true })
    await writeFile(path.join(root, '.claude/skills'), '../.agents/skills')
    await git(root, ['init']); await git(root, ['config', 'user.name', 'fixture']); await git(root, ['config', 'user.email', 'fixture@localhost'])
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base'])
    const before = await knowledgeFingerprint(root, signal)
    await mkdir(path.join(root, 'android_wiki/wiki/features/test'), { recursive: true })
    await writeFile(path.join(root, 'android_wiki/wiki/features/test/README.md'), '# Test')
    const added = await knowledgeFingerprint(root, signal)
    assert.notEqual(added, before)
    await writeFile(path.join(root, 'android_wiki/wiki/features/test/README.md'), '# Changed')
    assert.notEqual(await knowledgeFingerprint(root, signal), added)
    await assert.rejects(withWikiSkillAlias(root, async () => { throw new Error('gate rejected') }), /gate rejected/)
    assert.equal(await readFile(path.join(root, '.claude/skills'), 'utf8'), '../.agents/skills')
  } finally { await rm(root, { recursive: true, force: true }) }
})
