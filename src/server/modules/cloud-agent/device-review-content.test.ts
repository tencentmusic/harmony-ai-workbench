import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceReviewContent, DeviceReviewProgress } from './device-review-content'

test('semantic review retains every node, action, selector, state and provenance, with raw opt-in', () => {
  const attr = { type: 'XComponent', bounds: '[1,2][3,4]', hierarchy: 'ROOT,1', visible: 'false', selected: 'true', bundleName: 'app', text: 'room', backgroundColor: '#000000' }
  const raw = { commands: [{ argv: ['observe'], exit_code: 0 }], data: { nodes: [attr], surface_motion: { value: false } }, provenance: { path: 'raw', sha256: 'hash' }, children: [{ attributes: attr }] }
  const result = deviceReviewContent(JSON.stringify(raw))
  const read = JSON.parse(result.text)
  assert.equal(read.data.nodes.length, 1)
  for (const key of ['type', 'bounds', 'hierarchy', 'visible', 'selected', 'bundleName', 'text']) assert.equal(read.data.nodes[0][key], attr[key as keyof typeof attr])
  assert.equal(read.children[0].node_table.defaults.visible, 'false')
  assert.equal(read.children[0].node_table.rows.length, 1)
  assert.deepEqual(read.commands, raw.commands)
  assert.deepEqual(read.provenance, raw.provenance)
  assert.deepEqual(read.data.surface_motion, raw.data.surface_motion)
  assert.match(result.view, /raw=true/)
  assert.equal(raw.data.nodes[0].backgroundColor, '#000000')
})

test('duplicate native nodes reference the separately readable original layout without dropping assertion values', () => {
  const layout = { path: '/layout.json', sha256: 'digest' }
  const raw = { data: { nodes: [{ type: 'Video' }], room: { playing: true } }, provenance: { layout }, observations: [{ nodes: [{ type: 'Video' }], layout, at: 123 }] }
  const result = JSON.parse(deviceReviewContent(JSON.stringify(raw)).text)
  assert.deepEqual(result.data.nodes_reference, layout)
  assert.deepEqual(result.data.room, { playing: true })
  assert.deepEqual(result.observations[0].nodes_reference, layout)
  assert.equal(result.observations[0].at, 123)
})

test('reading progress can exceed three turns but bounded repeated stalls stop', () => {
  const progress = new DeviceReviewProgress()
  for (let offset = 0; offset < 10; offset++) assert.equal(progress.continue([{ path: 'tree', offset }]), true)
  assert.equal(progress.continue([{ path: 'tree', offset: 9 }]), true)
  assert.equal(progress.continue([{ path: 'tree', offset: 9 }]), false)
})
