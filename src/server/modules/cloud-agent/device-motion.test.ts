import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { observeSurfaceMotion } from './device-motion'

test('video motion requires changing pixels in the same visible surface, not image existence', async () => {
  const frame = async (color: string) => sharp({ create: { width: 200, height: 200, channels: 3, background: color } }).png().toBuffer()
  const nodes = [{ type: 'XComponent', id: 'video', bounds: '[0,0][200,200]', bundleName: 'app', visible: true }]
  const binding = { assertionId: 'motion', where: { type: 'XComponent', id: 'video' }, field: 'frame_motion' }
  const samples = await Promise.all(['#222', '#999', '#444'].map(async (color, i) => ({ at: i, nodes, image: await frame(color) })))
  assert.equal((await observeSurfaceMotion(samples, binding, 'app')).value, 'observed_surface_motion')
  assert.equal((await observeSurfaceMotion(samples.map(s => ({ ...s, image: samples[0].image })), binding, 'app')).value, undefined)
  await assert.rejects(observeSurfaceMotion(samples.slice(0, 1), binding, 'app'))
  await assert.rejects(observeSurfaceMotion(samples.map(s => ({ ...s, at: 0 })), binding, 'app'))
  await assert.rejects(observeSurfaceMotion(samples, { ...binding, where: { type: 'Image' } }, 'app'))
  await assert.rejects(observeSurfaceMotion(samples, binding, 'another.app'))
  await assert.rejects(observeSurfaceMotion(samples.map((s, i) => ({ ...s, nodes: [{ ...nodes[0], bounds: i ? '[1,1][190,190]' : nodes[0].bounds }] })), binding, 'app'))
})
