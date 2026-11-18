import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseExecutionConfig } from './execution-config'
import { gitlabRequestFor, GitLabTransientError } from './gitlab-access'

test('delivery separates code and knowledge credentials; explicit missing credentials never fall back', async () => {
  const original = { ...process.env }, fetchBefore = globalThis.fetch
  Object.assign(process.env, { CLOUD_AGENT_GITLAB_TOKEN: 'fallback', CLOUD_AGENT_GITLAB_HARMONY_TOKEN: 'source-fixture', CLOUD_AGENT_GITLAB_DOCS_TOKEN: 'docs-fixture' })
  const delivery = parseExecutionConfig({ delivery: { enabled: true, knowledge_id: 'docs', knowledge_branch: 'release', knowledge_path: 'docs/migrations', code_token_env: 'CLOUD_AGENT_GITLAB_HARMONY_TOKEN', knowledge_token_env: 'CLOUD_AGENT_GITLAB_DOCS_TOKEN' } }).delivery!
  const seen: string[] = []
  globalThis.fetch = async (_url, init) => { seen.push(new Headers(init?.headers).get('PRIVATE-TOKEN')!); return Response.json([]) }
  try {
    await gitlabRequestFor(delivery.codeTokenEnv)('https://git.example', '/projects/team%2Frepo/merge_requests', new AbortController().signal)
    await gitlabRequestFor(delivery.knowledgeTokenEnv)('https://git.example', '/projects/team%2Fdocs/merge_requests', new AbortController().signal)
    assert.deepEqual(seen, ['source-fixture', 'docs-fixture'])
    delete process.env.CLOUD_AGENT_GITLAB_DOCS_TOKEN
    await assert.rejects(gitlabRequestFor(delivery.knowledgeTokenEnv)('https://git.example', '/projects/team%2Fdocs/merge_requests', new AbortController().signal), /CLOUD_AGENT_GITLAB_DOCS_TOKEN/)
    assert.equal(seen.length, 2)
    for (const value of ['TOKEN_PEPPER', 'actual-token-value', '', 'CLOUD_AGENT_GITLAB_X_TOKEN\n']) assert.throws(() => parseExecutionConfig({ delivery: { enabled: true, knowledge_id: 'docs', knowledge_branch: 'release', knowledge_path: 'docs', code_token_env: value } }))
  } finally {
    globalThis.fetch = fetchBefore
    for (const key of ['CLOUD_AGENT_GITLAB_TOKEN', 'CLOUD_AGENT_GITLAB_HARMONY_TOKEN', 'CLOUD_AGENT_GITLAB_DOCS_TOKEN']) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
  }
})

test('GitLab classifies transient transport failures without leaking secrets; cancellation and auth never retry', async () => {
  const before = process.env.CLOUD_AGENT_GITLAB_TOKEN, fetchBefore = globalThis.fetch
  process.env.CLOUD_AGENT_GITLAB_TOKEN = 'private-fixture'
  const call = (signal = new AbortController().signal) => gitlabRequestFor()('https://git.example', '/projects/team%2Frepo/merge_requests', signal)
  try {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      globalThis.fetch = async () => new Response('', { status })
      await assert.rejects(call(), GitLabTransientError)
    }
    for (const status of [400, 401, 403, 404, 409]) {
      globalThis.fetch = async () => new Response('', { status })
      await assert.rejects(call(), error => error instanceof Error && !(error instanceof GitLabTransientError))
    }
    globalThis.fetch = async () => { throw new Error('private-fixture from transport') }
    await assert.rejects(call(), error => error instanceof GitLabTransientError && !error.message.includes('private-fixture'))
    const controller = new AbortController(); controller.abort()
    await assert.rejects(call(controller.signal), error => !(error instanceof GitLabTransientError))
    await assert.rejects(gitlabRequestFor()('http://git.example', '/projects/x/merge_requests', new AbortController().signal), /地址/)
    await assert.rejects(gitlabRequestFor()('https://git.example', '//evil.example', new AbortController().signal), /地址/)
  } finally { globalThis.fetch = fetchBefore; if (before === undefined) delete process.env.CLOUD_AGENT_GITLAB_TOKEN; else process.env.CLOUD_AGENT_GITLAB_TOKEN = before }
})
