import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReadCoverage, ReviewContinuation } from './code-review-domain'
import { refreshReviewCoverage } from './review-cycle'
import { reviewReadBatch } from './review-batch'
import { taskTool, textResult } from './task-tools'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readScoped } from './scoped-files'
import { boundedReviewPage } from './review-page'

test('HAR member continuation and batch reads preserve exact entry and invalidate on archive change', async () => {
  const archivePath = 'component/player.har', entry = 'package/src/Stream.d.ets'
  const key = `archive:${JSON.stringify([archivePath, entry])}`
  const coverage = new ReadCoverage()
  coverage.add(key, 0, { text: 'x'.repeat(24000), nextOffset: 24000 })
  const prompt = new ReviewContinuation().next(coverage, [key], '', [], false)!
  assert.match(prompt, /source_archive/)
  assert.ok(prompt.includes(JSON.stringify({ path: archivePath, entry, offset: 24000 })))
  const reader = taskTool('source_archive', '', {}, [], async args => {
    assert.deepEqual(args, { path: archivePath, entry, offset: 24000 })
    const chunk = { text: 'tail', nextOffset: null }
    coverage.add(key, Number(args.offset), chunk)
    return textResult(chunk)
  })
  await reviewReadBatch([reader], coverage, [key], [], AbortSignal.timeout(5000)).call({})
  coverage.require([key])
  const hashes = new Map([[key, 'old-hash']])
  const unchanged = await refreshReviewCoverage(coverage, hashes, async () => 'old-hash', true)
  unchanged.coverage.require([key])
  const changed = await refreshReviewCoverage(coverage, hashes, async () => 'new-hash', true)
  assert.deepEqual(changed.coverage.pending([key]), [{ key, offset: 0 }])
  assert.deepEqual(changed.existing, [key])
})

test('batch fills two bounded pages with exact offsets and skips complete files', async () => {
  const coverage = new ReadCoverage(), offsets: number[] = []
  const tool = taskTool('source_read', '', {}, [], async args => {
    offsets.push(Number(args.offset))
    const chunk = { text: 'x'.repeat(6000), nextOffset: Number(args.offset) < 12000 ? Number(args.offset) + 6000 : null }
    coverage.add(`harmony:${args.path}`, Number(args.offset), chunk)
    return textResult(chunk)
  })
  const batch = reviewReadBatch([tool], coverage, ['harmony:a.ets'], [], AbortSignal.timeout(5000))
  const first = JSON.parse((await batch.call({})).content.find(item => item.type === 'text')!.text)
  assert.equal(first.pages.length, 2)
  assert.deepEqual(offsets, [0, 6000])
  assert.deepEqual(first.pendingReads, [{ key: 'harmony:a.ets', offset: 12000 }])
  await batch.call({})
  coverage.require(['harmony:a.ets'])
  assert.equal(JSON.parse((await batch.call({})).content.find(item => item.type === 'text')!.text).pages.length, 0)
})

test('batch leaves denied and image reads pending without spinning or widening access', async () => {
  const coverage = new ReadCoverage()
  const tool = taskTool('source_read', '', {}, [], async () => { throw new Error('denied') })
  const batch = reviewReadBatch([tool], coverage, ['harmony:denied', 'harmony:cover.png'], ['cover.png'], AbortSignal.timeout(5000))
  const result = JSON.parse((await batch.call({})).content.find(item => item.type === 'text')!.text)
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].isError, true)
  assert.equal(result.pendingReads.length, 2)
  await assert.rejects(batch.call({ paths: ['../secret'] }), /参数/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(reviewReadBatch([tool], coverage, ['harmony:a.ets'], [], controller.signal).call({}))
})

test('real scoped readers deliver bounded pages without losing coverage and still deny traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-batch-'))
  try {
    await mkdir(path.join(root, 'app'))
    const keys = Array.from({ length: 5 }, (_, i) => `harmony:app/file${i}.ets`)
    for (let i = 0; i < 5; i++) await writeFile(path.join(root, `app/file${i}.ets`), 'a'.repeat(24001))
    const coverage = new ReadCoverage()
    const reader = taskTool('source_read', '', {}, [], async args => {
      const result = boundedReviewPage(textResult(await readScoped(root, args.path, ['app'], Number(args.offset))), Number(args.offset))
      const chunk = JSON.parse(result.content.find(item => item.type === 'text')!.text)
      coverage.add(`harmony:${args.path}`, Number(args.offset), chunk)
      return textResult(chunk)
    })
    const batch = reviewReadBatch([reader], coverage, [...keys, 'harmony:../secret'], [], AbortSignal.timeout(10000))
    for (let i = 0; i < 13; i++) await batch.call({})
    coverage.require(keys)
    assert.deepEqual(coverage.pending([...keys, 'harmony:../secret']), [{ key: 'harmony:../secret', offset: 0 }])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('clipped final source page stays pending until every delivered character is read', () => {
  const coverage = new ReadCoverage(), input = '字'.repeat(15000)
  const delivered: string[] = []
  for (let offset = 0; offset < input.length; offset += 6000) {
    const result = boundedReviewPage(textResult({ text: input.slice(offset), sha256: 'unchanged', nextOffset: null }), offset)
    const chunk = JSON.parse(result.content.find(item => item.type === 'text')!.text)
    delivered.push(chunk.text)
    coverage.add('source', offset, chunk)
    assert.equal(chunk.sha256, 'unchanged')
    if (offset < 12000) assert.equal(coverage.pending(['source']).length, 1)
  }
  coverage.require(['source'])
  assert.equal(delivered.join(''), input)
})
