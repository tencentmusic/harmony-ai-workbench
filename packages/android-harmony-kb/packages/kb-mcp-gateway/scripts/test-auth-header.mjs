#!/usr/bin/env node
import assert from 'node:assert/strict'
import { extractBearer, extractTokenFromRequest } from '../lib/auth.mjs'

assert.equal(extractBearer('Bearer hm_test_token'), 'hm_test_token')
assert.equal(extractBearer('hm_test_token'), 'hm_test_token')
assert.equal(extractBearer('bearer hm_test_token'), 'hm_test_token')
assert.equal(extractBearer(''), null)
assert.equal(extractBearer(null), null)

assert.equal(
  extractTokenFromRequest({ headers: { authorization: 'Bearer hm_test_token' } }),
  'hm_test_token',
)
assert.equal(
  extractTokenFromRequest({ headers: { 'x-kb-mcp-token': 'hm_alt_token' } }),
  'hm_alt_token',
)
assert.equal(extractTokenFromRequest({ headers: {} }), null)

console.log('auth extractBearer test: ok')
