import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTaskTools, taskTool, textResult } from './task-tools'
import { CloudRecoveryError } from './domain'

test('concurrent model tools queue behind the running call instead of reporting unavailable', async () => {
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  let active = 0, maximum = 0
  const endpoint = await startTaskTools([
    taskTool('first', 'fixture', {}, [], async () => { active++; maximum = Math.max(maximum, active); started(); await gate; active--; return textResult('first completed') }),
    taskTool('next', 'fixture', {}, [], async () => { active++; maximum = Math.max(maximum, active); active--; return textResult('next completed') }),
  ], new AbortController().signal, async () => {})
  const client = new Client({ name: 'queued-tools', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    const first = client.callTool({ name: 'first' })
    await ready
    const queued = client.callTool({ name: 'next' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await endpoint.settle(0), false)
    release()
    assert.notEqual((await first).isError, true)
    const result = await queued
    assert.notEqual(result.isError, true)
    assert.deepEqual(result.content, textResult('next completed').content)
    assert.equal(maximum, 1)
    assert.equal(await endpoint.settle(1000), true)
  } finally { release(); await client.close(); await endpoint.close() }
})

test('a cancelled queued call cannot overtake an active mutation, and recovery blocks the queue', async () => {
  for (const uncertain of [false, true]) {
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    const executed: string[] = []
    const endpoint = await startTaskTools([
      taskTool('first', 'fixture', {}, [], async () => { executed.push('start'); started(); await gate; executed.push('end'); if (uncertain) throw new CloudRecoveryError('native action uncertain', 409); return textResult('saved') }),
      taskTool('cancelled', 'fixture', {}, [], async () => { executed.push('cancelled'); return textResult('unexpected') }),
      taskTool('next', 'fixture', {}, [], async () => { executed.push('next'); return textResult('done') }),
    ], new AbortController().signal, async () => {})
    const client = new Client({ name: 'queue-cancellation', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
      const first = client.callTool({ name: 'first' })
      await ready
      const cancelled = client.callTool({ name: 'cancelled' }, undefined, { timeout: 40 }).catch(() => null)
      const next = client.callTool({ name: 'next' })
      await cancelled
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.deepEqual(executed, ['start'])
      release()
      await first
      const result = await next
      assert.equal(!!result.isError, uncertain)
      assert.deepEqual(executed, uncertain ? ['start', 'end'] : ['start', 'end', 'next'])
      assert.equal(await endpoint.settle(1000), !uncertain)
    } finally { release(); await client.close(); await endpoint.close() }
  }
})

test('long tools stream keepalive before completion even without a progress token', { timeout: 45000 }, async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const endpoint = await startTaskTools([taskTool('slow', 'fixture', {}, [], async () => { await gate; return textResult('finished') })], new AbortController().signal, async () => {})
  const abort = new AbortController()
  try {
    const response = await fetch(endpoint.config.url, { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(40000)]),
      headers: { ...endpoint.config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }) })
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
    const reader = response.body!.getReader()
    // Network chunks may split/coalesce events or contain transport keepalive comments.
    const decoder = new TextDecoder()
    let buffer = '', notifications = 0
    while (notifications < 2) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const message = JSON.parse(data)
        assert.equal(message.method, 'notifications/message')
        assert.equal(message.params.data.status, 'running')
        notifications++
      }
    }
    assert.equal(endpoint.busy(), true)
    release()
    let tail = ''
    for (;;) { const item = await reader.read(); if (item.done) break; tail += new TextDecoder().decode(item.value) }
    assert.match(tail, /finished/)
  } finally { release(); abort.abort(); await endpoint.close() }
})

test('disconnected call settles once without closing endpoint or replaying mutation', async () => {
  let release!: () => void, started!: () => void
  let writes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  const endpoint = await startTaskTools([
    taskTool('write', 'fixture', {}, [], async () => { writes++; started(); await gate; return textResult('saved') }),
    taskTool('read', 'fixture', {}, [], async () => textResult(writes)),
  ], new AbortController().signal, async () => {})
  const client = new Client({ name: 'settlement', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    const call = client.callTool({ name: 'write' }, undefined, { timeout: 50 }).catch(() => null)
    await ready
    await call
    assert.equal(endpoint.busy(), true)
    assert.equal(await endpoint.settle(0), false)
    const settling = endpoint.settle(1000)
    release()
    assert.equal(await settling, true)
    assert.equal(writes, 1)
    assert.deepEqual((await client.callTool({ name: 'read' })).content, textResult(1).content)
  } finally { release(); await client.close(); await endpoint.close() }
})

test('settlement never clears uncertain recovery and respects cancellation', async () => {
  const controller = new AbortController()
  const endpoint = await startTaskTools([taskTool('uncertain', 'fixture', {}, [], async () => { throw new CloudRecoveryError('unknown outcome', 409) })], controller.signal, async () => {})
  const client = new Client({ name: 'recovery', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
    assert.equal((await client.callTool({ name: 'uncertain' })).isError, true)
    assert.equal(await endpoint.settle(100), false)
    assert.equal(endpoint.recovery(), true)
    controller.abort()
    await assert.rejects(endpoint.settle(100), /abort/i)
  } finally { await client.close(); await endpoint.close() }
})

test('in-flight settlement obeys the original deadline and abort without pretending the tool stopped', async () => {
  for (const cancel of [false, true]) {
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    const controller = new AbortController()
    const endpoint = await startTaskTools([taskTool('slow', 'fixture', {}, [], async () => { started(); await gate; return textResult('done') })], controller.signal, async () => {}, cancel ? 10000 : 100)
    const client = new Client({ name: 'bounded-wait', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
      const call = client.callTool({ name: 'slow' }).catch(() => null)
      await ready
      const before = Date.now()
      const settled = endpoint.settle(5000)
      if (cancel) { controller.abort(); await assert.rejects(settled, /abort/i) }
      else assert.equal(await settled, false)
      assert.ok(Date.now() - before < 2000, 'must not restart the operation timeout at end of model turn')
      assert.equal(endpoint.busy(), true)
      release()
      await call
      assert.equal(await endpoint.drain(1000), true)
    } finally { release(); await client.close(); await endpoint.close() }
  }
})
