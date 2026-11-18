import assert from 'node:assert/strict'
import test from 'node:test'
import { harnessRequestName } from './request-file'

test('request names have bounded length and preserve operation/content identity', () => {
  const name = harnessRequestName('record-evidence', 'a'.repeat(100), '{"v":3}')
  assert.equal(name.length, 69)
  assert.equal(name, harnessRequestName('record-evidence', 'a'.repeat(100), '{"v":3}'))
  assert.notEqual(name, harnessRequestName('record-evidence', 'a'.repeat(100), '{"v":4}'))
  assert.notEqual(name, harnessRequestName('record-parity', 'a'.repeat(100), '{"v":3}'))
})
