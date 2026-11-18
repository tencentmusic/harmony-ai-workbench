#!/usr/bin/env node
import assert from 'node:assert/strict'

const {
  opencodeSessionMatchesModel,
  parseOpencodeModelLabel,
  reconcileOpencodeSessionId,
} = await import('../src/lib/opencode/opencode-session.ts')

assert.deepEqual(parseOpencodeModelLabel('sub2api/gpt-5.6-luna'), {
  providerID: 'sub2api',
  modelID: 'gpt-5.6-luna',
})

assert.equal(
  opencodeSessionMatchesModel(
    { providerID: 'deepseek', id: 'deepseek-v4-flash' },
    'sub2api/gpt-5.6-luna',
  ),
  false,
)

assert.equal(
  opencodeSessionMatchesModel(
    { providerID: 'sub2api', id: 'gpt-5.6-luna' },
    'sub2api/gpt-5.6-luna',
  ),
  true,
)

assert.equal(opencodeSessionMatchesModel(null, 'sub2api/gpt-5.6-luna'), true)

const originalFetch = globalThis.fetch
process.env.OPENCODE_MODEL = 'sub2api/gpt-5.6-luna'
process.env.OPENCODE_BASE_URL = 'http://127.0.0.1:4098'
process.env.OPENCODE_SERVER_USERNAME = 'opencode'
process.env.OPENCODE_SERVER_PASSWORD = 'a'.repeat(64)

const cfg = {
  baseUrl: 'http://127.0.0.1:4098',
  timeoutMs: 120000,
  username: 'opencode',
  password: 'a'.repeat(64),
}

try {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/session\/ses_test$/)
    assert.ok(init?.headers?.get?.('Authorization')?.startsWith('Basic '))
    return new Response(
      JSON.stringify({
        model: { providerID: 'deepseek', id: 'deepseek-v4-flash' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const reconciled = await reconcileOpencodeSessionId('ses_test', cfg)
  assert.equal(reconciled, null)
} finally {
  globalThis.fetch = originalFetch
}

console.log('test-opencode-session-reconcile: ok')
