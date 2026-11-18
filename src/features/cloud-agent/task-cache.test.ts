import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskCache } from './task-cache'

const task = (id: string, revision = 1) => ({ id, revision, updatedAt: String(revision).padStart(4, '0') })
test('task cache deduplicates in-flight requests, keeps newer updates and clears outstanding writes', async () => {
  const cache = new TaskCache<ReturnType<typeof task>>(2)
  let finish!: (value: ReturnType<typeof task>) => void, calls = 0
  const load = () => { calls++; return new Promise<ReturnType<typeof task>>(resolve => { finish = resolve }) }
  const first = cache.load('a', load), second = cache.load('a', load)
  assert.equal(first, second)
  assert.equal(calls, 1)
  cache.put(task('a', 2)); finish(task('a'))
  assert.equal((await first).revision, 2)
  assert.equal(cache.get('a')?.revision, 2)
  const pending = cache.load('b', load)
  cache.clear(); finish(task('b'))
  await assert.rejects(pending, /discarded/)
  assert.equal(cache.get('b'), undefined)
})
test('task cache is bounded, separates ids and releases failed requests', async () => {
  const cache = new TaskCache<ReturnType<typeof task>>(2)
  cache.put(task('a')); cache.put(task('b')); cache.get('a'); cache.put(task('c'))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a')?.id, 'a')
  await assert.rejects(cache.load('d', async () => { throw Error('offline') }))
  assert.equal((await cache.load('d', async () => task('d'))).id, 'd')
  cache.delete('d'); assert.equal(cache.get('d'), undefined)
})
