import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewVisualStates, reviewFileLabel } from './review-visuals'

test('group UI assets by state identity, not attachment order, including old text/plain HTML', () => {
  const files = [
    { id: 'a', label: 'prototypes/loading', mime: 'text/plain' },
    { id: 'b', label: 'baselines/ready', mime: 'image/png' },
    { id: 'c', label: 'prototypeRenders/loading', mime: 'image/png' },
    { id: 'd', label: 'baselines/loading', mime: 'image/jpeg' },
    { id: 'e', label: 'layoutSpec', mime: 'text/plain' },
  ]
  const states = reviewVisualStates(files)
  assert.equal(states.length, 2)
  assert.equal(states[0].id, 'loading')
  assert.equal(states[0].prototype?.id, 'a')
  assert.equal(states[0].baseline?.id, 'd')
  assert.equal(states[1].prototype, undefined)
  assert.equal(reviewFileLabel(files[4]), '布局说明')
})
