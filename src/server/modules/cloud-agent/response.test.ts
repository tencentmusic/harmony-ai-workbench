import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBoundedJson } from './response'
import { readCloudBody } from './http'

test('upstream response is bounded while streaming, not after full allocation', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(100)) }, cancel() { cancelled = true } })
  await assert.rejects(readBoundedJson(new Response(stream), 150), /超过/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readBoundedJson(Response.json({ ok: true }), 100), { ok: true })
})
test('API rejects malformed and oversized bodies', async () => {
  await assert.rejects(readCloudBody(new Request('http://localhost', { method: 'POST', body: '{' })), /格式/)
  await assert.rejects(readCloudBody(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(101) }), 100), /限制/)
})
