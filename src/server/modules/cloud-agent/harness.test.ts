import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCapabilities, projectHarnessStatus, assertCandidatePayload, scopeReviewBlockers, reviewGateFailure, agentRecordPayload } from './harness-domain'

test('test exclusions are preserved human decisions, not agent-writable fields', () => {
  const test_exclusions = [{ path: '/case/human-exclusion.json', sha256: 'hash' }]
  assert.deepEqual(agentRecordPayload({ test_exclusions }, {}, 'record-parity'), { test_exclusions })
  assert.throws(() => agentRecordPayload({}, { test_exclusions }, 'record-parity'), /人工审批/)
  assert.throws(() => agentRecordPayload({ test_exclusions }, { test_exclusions: [] }, 'record-parity'), /人工审批/)
})
import { CloudError, CloudRecoveryError } from './domain'
import { executionTools, harnessRoot, harnessRuleTools, type HarnessWorkspace } from './harness'

test('uninitialized Harness tools direct the agent to start the archive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-harness-uninitialized-'))
  try {
    const workspace = { artifactRoot: root, runDir: path.join(root, 'harness'), androidRoot: root, harmonyRoot: root,
      androidPrefixes: [''], harmonyPrefixes: [''] } as HarnessWorkspace
    const tools = await executionTools(workspace, new AbortController().signal, async () => {}, false)
    for (const [name, args] of [
      ['harness_status', {}],
      ['harness_record', { command: 'record-context', section: 'application', payload: {}, operationId: 'initial-context' }],
    ] as const) {
      const tool = tools.find(item => item.definition.name === name)!
      await assert.rejects(tool.call(args), /调用 harness_start/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('only record-change may register a completed source skeleton audit', () => {
  const audit = { status: 'passed', zero_callers: [], zero_consumers: [], write_only_fields: [], notes: 'Checked every current source chain' }
  const payload = { changes: [], reachability: [{ parity_id: 'P-1', status: 'passed', proof: {} }], skeleton_audit: audit }
  assert.deepEqual(agentRecordPayload({}, payload, 'record-change'), payload)
  assert.equal(audit.status, 'passed', 'validation must not mutate the payload')
  for (const command of [undefined, 'record-context', 'record-evidence', 'record-parity']) {
    assert.throws(() => agentRecordPayload({}, payload, command), /人工批准/)
  }
  for (const key of ['zero_callers', 'zero_consumers', 'write_only_fields']) {
    for (const value of [undefined, null, 'none', ['unresolved']]) {
      assert.throws(() => agentRecordPayload({}, { skeleton_audit: { ...audit, [key]: value } }, 'record-change'), /自检/)
    }
  }
  assert.throws(() => agentRecordPayload({}, { skeleton_audit: { ...audit, notes: '' } }, 'record-change'), /自检/)
  for (const value of [
    { nested: { skeleton_audit: audit } },
    { skeleton_audit: { ...audit, reviewer: 'agent' } },
    { skeleton_audit: { ...audit, nested: { status: 'passed' } } },
    { skeleton_audit: { ...audit, status: 'approved' } },
    { ...payload, build: { status: 'passed' } },
    { ...payload, static: { status: 'passed' } },
    { ...payload, device: { status: 'passed' } },
    { ...payload, ui_review: { status: 'approved' } },
    { ...payload, reachability: [{ status: 'approved' }] },
    { ...payload, reachability: [{ status: 'passed', proof: { status: 'passed' } }] },
    { ...payload, reachability: [{ status: 'passed', reviewer: 'agent' }] },
    { nested: { reachability: [{ status: 'passed' }] } },
  ]) assert.throws(() => agentRecordPayload({}, value, 'record-change'))
})

test('whole-ledger agent writes preserve omitted pending and approved decisions without changing caller data', () => {
  const existing = { ui_review: { status: 'pending' }, scope_approval: { status: 'approved', reviewer: 'human' }, approval: { reference: 'receipt' }, items: ['old'] }
  const payload = { items: ['new'] }
  assert.deepEqual(agentRecordPayload(existing, payload), { ...existing, ...payload })
  assert.deepEqual(payload, { items: ['new'] })
  assert.deepEqual(existing.items, ['old'])
  assert.deepEqual(agentRecordPayload({ ...existing, removedFact: 'old' }, payload), { ...existing, ...payload })
  assert.deepEqual(agentRecordPayload(existing, { ...payload, ui_review: existing.ui_review }), { ...existing, ...payload })
  for (const key of ['ui_review', 'scope_approval', 'approval']) {
    for (const value of [null, {}, { status: 'approved' }]) assert.throws(() => agentRecordPayload(existing, { [key]: value }), /不得修改人工审批字段/)
    assert.throws(() => agentRecordPayload({}, { [key]: { status: 'pending' } }), /不得修改人工审批字段/)
  }
  assert.throws(() => agentRecordPayload(existing, { nested: { reviewer: 'agent' } }), /人工批准/)
})

test('scope preflight allows a new human decision but rejects incomplete engineering facts', () => {
  const blockers = [
    { code: 'review_scope_pending', message: 'human decision pending' },
    { code: 'review_scope_package_stale', message: 'old approval' },
    { code: 'review_scope_not_presented', message: 'new presentation needed' },
    { code: 'parity_required_field_missing', message: 'P-1: missing android_behavior' },
    { code: 'review_scope_question_open', message: 'unknown business fact' },
  ]
  assert.deepEqual(scopeReviewBlockers(blockers), blockers.slice(3))
})

test('verified rejection is an actionable validation error, not a process recovery error', () => {
  const failure = reviewGateFailure({ phase: 'evidence_ready', blockers: [{ code: 'parity_required_field_missing', message: 'P-1: missing behavior' }], next: [] })
  assert.ok(failure instanceof CloudError)
  assert.ok(!(failure instanceof CloudRecoveryError))
  assert.match(failure.message, /P-1: missing behavior/)
  assert.match(reviewGateFailure({ phase: 'evidence_ready', blockers: [], next: ['Complete parity'] }).message, /evidence_ready.*Complete parity/)
})

test('rule discovery exposes readable paths and missing rules direct to discovery not candidate creation', async () => {
  const tools = harnessRuleTools()
  const catalog = tools.find(tool => tool.definition.name === 'harness_rule_catalog')!
  const reader = tools.find(tool => tool.definition.name === 'harness_rule')!
  const result = await catalog.call({ query: 'START_HERE' })
  const content = result.content[0]
  assert.equal(content.type, 'text')
  if (content.type === 'text') assert.ok(JSON.parse(content.text).files.includes('START_HERE.md'))
  await reader.call({ path: 'START_HERE.md' })
  await assert.rejects(reader.call({ path: 'schemas/not-a-real-rule.json' }), error => error instanceof Error && error.message.includes('harness_rule_catalog') && !error.message.includes('candidate'))
  await assert.rejects(reader.call({ path: 'skills/../../secret.md' }))
})

test('handshake rejects unknown engine, schema and gate versions', async () => {
  const contract = JSON.parse(await readFile(path.join(harnessRoot(), 'release-capabilities.json'), 'utf8'))
  validateCapabilities(contract)
  for (const patch of [{ protocol_version: 9 }, { implementation_id: 'other' }, { gate_versions: {} }, { execution_preflight: {} }, { acceptance: {} }, { device_preparation: null }, { quality_contract: { version: 1, engine_files: {} } }, { artifact_schema: { readable: [3], writable: [] } }]) {
    assert.throws(() => validateCapabilities({ ...contract, ...patch }))
  }
})

test('only authoritative harness verification projects passed nodes', () => {
  assert.throws(() => projectHarnessStatus({ phase: 'wired', authoritative: false }))
  assert.throws(() => projectHarnessStatus({ phase: 'unknown' }))
  const result = projectHarnessStatus({ phase: 'evidence_ready', verified: false, blockers: [{ code: 'approval', message: 'pending human' }], next_actions: ['review scope'], gates: {} })
  assert.equal(result.nodes.filter(node => node.status === 'passed').length, 3)
  assert.equal(result.nodes[3].status, 'blocked')
  assert.equal(result.nodes[4].status, 'pending')
})

test('agent candidate records cannot include human approval or verified execution', () => {
  assertCandidatePayload({ sources: [{ type: 'screenshot' }], review_package: { status: 'pending' } })
  for (const value of [{ approval: { status: 'approved' } }, { ui_review: {} }, { nested: { reviewer: 'user' } }, { status: 'passed' }]) assert.throws(() => assertCandidatePayload(value))
})
