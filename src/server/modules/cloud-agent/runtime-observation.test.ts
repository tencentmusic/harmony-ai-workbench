import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { readRuntimeObservation, runtimeEvidence, nativeRuntimeTools } from './native-runtime'
import { sha256 } from './scoped-files'
import type { HarnessWorkspace } from './harness'
import { startTaskTools } from './task-tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

test('native hidden observations are model-readable and usable as evidence but remain scoped and hash bound', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-observation-'))
  const workspace = { artifactRoot: root, runDir: path.join(root, 'harness') } as HarnessWorkspace
  try {
    const directory = path.join(workspace.runDir, '.harness-runtime/device-fixture')
    await mkdir(directory, { recursive: true })
    const picture = await sharp({ create: { width: 80, height: 100, channels: 3, background: '#ddd' } }).jpeg().toBuffer()
    await writeFile(path.join(directory, '0.jpeg'), picture)
    const result = await readRuntimeObservation(workspace, { path: 'device-fixture/0.jpeg', sha256: sha256(picture) })
    assert.ok(result.content.some(item => item.type === 'image'))
    const endpoint = await startTaskTools(nativeRuntimeTools(workspace, new AbortController().signal, async () => {}, false), new AbortController().signal, async () => {})
    const client = new Client({ name: 'native-observation-fixture', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.config.url), { requestInit: { headers: endpoint.config.headers } }))
      const names = (await client.listTools()).tools.map(tool => tool.name)
      assert.ok(names.includes('harness_observation_read') && names.includes('harness_execution_plan'))
      assert.ok(!names.includes('harness_acceptance') && !names.includes('harness_prepare_fixtures'))
      const image = await client.callTool({ name: 'harness_observation_read', arguments: { path: 'device-fixture/0.jpeg', sha256: sha256(picture) } })
      assert.equal(image.isError, undefined)
      assert.ok((image.content as { type: string }[]).some(item => item.type === 'image'))
    } finally { await client.close(); await endpoint.close() }
    await runtimeEvidence(workspace, { path: 'harness/.harness-runtime/device-fixture/0.jpeg', sha256: sha256(picture) })
    await writeFile(path.join(directory, '0.json'), '{"nodes":[]}')
    const text = await readRuntimeObservation(workspace, { path: 'device-fixture/0.json', sha256: sha256('{"nodes":[]}') })
    assert.ok(text.content.some(item => item.type === 'text' && item.text.includes('nodes')))
    await assert.rejects(readRuntimeObservation(workspace, { path: '../../approvals/human.txt', sha256: 'a'.repeat(64) }))
    await assert.rejects(readRuntimeObservation(workspace, { path: 'device-fixture/0.jpeg', sha256: 'a'.repeat(64) }), /已变化/)
    await assert.rejects(runtimeEvidence(workspace, { path: '../foreign.png', sha256: 'a'.repeat(64) }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
