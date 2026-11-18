import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HARNESS_PHASES, type CloudHarness } from '@/contracts/cloud-agent'
import { ExecutionContinuation, executionStep, executionEnvironmentIssue, ExecutionProgress } from './execution-continuation'
import { CloudEnvironmentError } from './domain'

function status(phase = 'ui_prototype_approved', reviewed = false): CloudHarness {
  return { phase, checkedAt: '', branch: '', worktree: '', runDir: '', blockers: [], next: [], reviewPackage: '',
    nodes: HARNESS_PHASES.map(([id, label], i) => ({ id, label, status: i <= HARNESS_PHASES.findIndex(([p]) => p === phase) ? 'passed' : 'pending' })),
    codeReview: { status: reviewed ? 'passed' : 'pending', summary: '', findings: [], checks: [] } }
}
const config = { build: { cwd: '.', artifact: 'a.hap', command: ['node', 'build'], timeoutSeconds: 30, dependencies: [] } }

test('external scenario holds permit one visual dependency audit and preserve the actual stop reason', () => {
  const current = status('build_passed', true), policy = new ExecutionContinuation()
  current.continuation = { status: 'external_block', canEndTurn: true, reason: 'Independent work exhausted; listed dependencies remain', pending: [], blocked: [
    { action: 'complete_visual_comparison_or_record_existing_decision', owner: 'agent', reason: 'Declared shared prerequisite remains', condition: '', scenarios: [] },
    { action: 'wait_for_dependency', owner: 'external', reason: 'Failure sample missing', condition: 'Provide an authorized sample', scenarios: ['motion'] },
  ], readyScenarios: [], diagnosisScenarios: [] }
  const next = policy.decide({ status: current, progress: 0 })
  assert.equal(next.kind, 'continue')
  assert.match(next.prompt!, /harness_capture/)
  assert.match(next.prompt!, /不操作网络/)
  const held = policy.decide({ status: current, progress: 1 })
  assert.equal(held.kind, 'blocked')
  assert.match(held.reason, /Failure sample missing/)
  assert.match(held.reason, /Provide an authorized sample/)
  assert.equal(new ExecutionContinuation().decide({ status: current, progress: 0, review: 'visual' }).kind, 'approval')
  for (const extra of [{ environmentIssue: 'Device unavailable' }, { exhausted: true }]) {
    assert.equal(new ExecutionContinuation().decide({ status: current, progress: 0, ...extra }).kind, 'blocked')
  }
  for (const state of ['paused', 'closed_with_gaps']) {
    assert.equal(new ExecutionContinuation().decide({ status: { ...current, continuation: { ...current.continuation, status: state } }, progress: 0, review: 'visual' }).kind, 'blocked')
  }
  current.blockers.push({ code: 'operation_in_doubt', message: 'Unknown device side effect' })
  assert.equal(new ExecutionContinuation().decide({ status: current, progress: 0, review: 'visual' }).kind, 'blocked')
})

test('confirmed swipe with post-action layout timeout gets one same-ID recovery turn', () => {
  const current = status('build_passed', true), policy = new ExecutionContinuation()
  current.blockers.push({ code: 'operation_in_doubt', message: 'Device action unresolved' })
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [], blocked: [], readyScenarios: [], diagnosisScenarios: [] }
  const input = { status: current, progress: 0, lastError: 'POST_SWIPE_LAYOUT_TIMEOUT operationId=swipe-1' }
  const first = policy.decide(input)
  assert.equal(first.kind, 'continue')
  assert.match(first.prompt || '', /原operationId/)
  assert.equal(policy.decide(input).kind, 'blocked')
  assert.equal(new ExecutionContinuation().decide({ ...input, lastError: 'Device action unresolved' }).kind, 'blocked')
})

test('closeout-only scheduler returns to unresolved static checks instead of repeatedly finalizing', () => {
  const current = status('wired'), policy = new ExecutionContinuation()
  current.codeReview = { status: 'failed', summary: 'Missing SDK contract', findings: [], checks: [{ id: 'negative conclusions', status: 'blocked', evidence: 'Inspect player.har declarations' }] }
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'complete_acceptance_closeout', owner: 'agent', reason: '', condition: '', scenarios: [] }], blocked: [{ action: 'complete_static_checks', owner: 'agent', reason: 'Declared shared prerequisite remains', condition: '', scenarios: [] }, { action: 'complete_build', owner: 'agent', reason: 'static', condition: '', scenarios: [] }], readyScenarios: [], diagnosisScenarios: [] }
  const decision = policy.decide({ status: current, progress: 0 })
  assert.equal(decision.kind, 'continue')
  assert.match(decision.prompt!, /source_archive/)
  assert.match(decision.prompt!, /player.har/)
  assert.match(decision.prompt!, /禁止调用 harness_finalize/)
  for (let i = 0; i < 9; i++) {
    const next = policy.decide({ status: current, progress: 0, lastError: 'artifact_read missing' })
    if (next.kind === 'blocked') {
      assert.match(next.reason, /Inspect player.har/)
      assert.doesNotMatch(next.reason, /artifact_read missing/)
      return
    }
  }
  assert.fail('unchanged evidence still needs a bounded stop with the real prerequisite')
})

test('missing formal executor permits smoke and independent preparation, but not repeated formal tests', () => {
  const current = status('build_passed', true), policy = new ExecutionContinuation()
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'execute_required_scenarios', owner: 'agent', reason: '', condition: '', scenarios: ['one'] }, { action: 'complete_acceptance_closeout', owner: 'agent', reason: '', condition: '', scenarios: [] }], blocked: [], readyScenarios: [], diagnosisScenarios: [] }
  const input = { status: current, progress: 1, deviceTestIssue: '请配置 descriptor' }
  assert.match(policy.decide(input).prompt || '', /harness_device_smoke/)
  const recovery = policy.decide({ ...input, progress: 2 })
  assert.equal(recovery.kind, 'continue')
  assert.match(recovery.prompt!, /dismiss/)
  assert.match(recovery.prompt!, /不要调用 harness_test/)
  current.continuation.pending.push({ action: 'prepare_isolated_fixture', owner: 'agent', reason: '', condition: '', scenarios: ['independent'] })
  const independent = policy.decide(input)
  assert.equal(independent.kind, 'continue')
  assert.match(independent.prompt!, /不要调用 harness_test/)
  assert.equal(new ExecutionContinuation().decide({ ...input, status: status('wired') }).kind, 'continue')
})

test('formal test environment error does not suppress smoke diagnostics', async () => {
  const progress = new ExecutionProgress()
  const tool = progress.observe({ definition: { name: 'harness_test', inputSchema: { type: 'object' } }, call: async () => { throw new CloudEnvironmentError('descriptor missing', 503) } })
  await assert.rejects(tool.call({}))
  assert.equal(progress.environmentIssue, '')
  assert.match(progress.deviceTestIssue, /descriptor/)
})

test('native closeout cannot spin while its build prerequisite is unavailable', () => {
  const current = status('wired', true)
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'complete_acceptance_closeout', owner: 'agent', reason: '', condition: '', scenarios: [] }], blocked: [{ action: 'complete_build', owner: 'agent', reason: 'Declared shared prerequisite remains', condition: '', scenarios: [] }], readyScenarios: [], diagnosisScenarios: [] }
  const decision = new ExecutionContinuation().decide({ status: current, progress: 10, environmentIssue: '构建工具未受信任：设置 DEVECO_HOME' })
  assert.equal(decision.kind, 'blocked')
  assert.match(decision.reason, /DEVECO_HOME/)
  const repair = new ExecutionContinuation()
  const diagnosis = repair.decide({ status: current, progress: 10 })
  assert.equal(diagnosis.kind, 'continue')
  assert.match(diagnosis.prompt || '', /harness_build_context/)
  assert.equal(repair.decide({ status: current, progress: 10 }).kind, 'blocked')
  assert.equal(new ExecutionContinuation().decide({ status: { ...current, codeReview: { status: 'failed', summary: 'repair source first', findings: [], checks: [] } }, progress: 10 }).kind, 'continue')
  current.continuation.pending.push({ action: 'complete_build', owner: 'agent', reason: '', condition: '', scenarios: [] })
  assert.equal(new ExecutionContinuation().decide({ status: current, progress: 10, environmentIssue: '构建工具未受信任' }).kind, 'blocked')
  current.continuation.pending.push({ action: 'prepare_isolated_fixture', owner: 'agent', reason: '', condition: '', scenarios: ['independent'] })
  const independent = new ExecutionContinuation().decide({ status: current, progress: 10, environmentIssue: '构建工具未受信任' })
  assert.equal(independent.kind, 'continue')
  assert.doesNotMatch(independent.prompt!, /调用 harness_build；/)
})

test('environment failure survives later errors but clears after a successful tool retry', async () => {
  const progress = new ExecutionProgress()
  let fails = true
  const build = progress.observe({ definition: { name: 'harness_build', inputSchema: { type: 'object' } }, call: async () => {
    if (fails) throw new CloudEnvironmentError('设置 DEVECO_HOME', 503)
    return { content: [] }
  } })
  await assert.rejects(build.call({}), /DEVECO_HOME/)
  for (const name of ['harness_rule', 'harness_finalize', 'harness_prepare_fixtures']) {
    await progress.observe({ definition: { name, inputSchema: { type: 'object' } }, call: async () => ({ isError: true, content: [] }) }).call({})
  }
  assert.match(progress.environmentIssue, /DEVECO_HOME/)
  fails = false
  await build.call({})
  assert.equal(progress.environmentIssue, '')
})

test('stationary native build escalates to diagnosis before stopping without bypassing safety', () => {
  const current = status('wired', true), policy = new ExecutionContinuation()
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'complete_build', owner: 'agent', reason: '', condition: '', scenarios: [] }], blocked: [], readyScenarios: [], diagnosisScenarios: [] }
  policy.decide({ status: current, progress: 0 })
  policy.decide({ status: current, progress: 0 })
  const diagnosis = policy.decide({ status: current, progress: 0 })
  assert.equal(diagnosis.kind, 'continue')
  assert.match(diagnosis.prompt || '', /harness_build_context/)
  let result = policy.decide({ status: current, progress: 0 })
  for (let i = 0; i < 10 && result.kind === 'continue'; i++) result = policy.decide({ status: current, progress: 0 })
  assert.equal(result.kind, 'blocked')
  current.blockers.push({ code: 'operation_in_doubt', message: 'inspect process first' })
  assert.equal(new ExecutionContinuation().decide({ status: current, progress: 0 }).kind, 'blocked')
})
test('continuation hands verified failed review back to coder before requesting another review', () => {
  const current = status('wired')
  current.codeReview = { status: 'failed', summary: 'source issue', checks: [], findings: [{ severity: 'P1', path: 'Home.ets', line: 42, message: 'Missing lifecycle stop' }] }
  const decision = new ExecutionContinuation().decide({ status: current, progress: 0 })
  assert.equal(decision.kind, 'continue')
  assert.match(decision.prompt || '', /Missing lifecycle stop/)
  assert.match(decision.prompt || '', /Home\.ets/)
  assert.match(decision.prompt || '', /未修复的同一代码/)
})
test('normal final text cannot finish coding; native checkpoints determine the next step', () => {
  const policy = new ExecutionContinuation()
  for (const [phase, reviewed, step] of [['ui_prototype_approved', false, 'implementation'], ['implemented', false, 'wiring'], ['wired', false, 'review'], ['wired', true, 'build'], ['build_passed', true, 'device'], ['functional_parity_passed', true, 'finalize']] as const) {
    const current = status(phase, reviewed)
    assert.equal(executionStep(current), step)
    assert.equal(policy.decide({ status: current, progress: 0 }).kind, 'continue')
  }
  assert.equal(policy.decide({ status: status('delivery_ready', true), progress: 0 }).kind, 'complete')
  assert.equal(new ExecutionContinuation().decide({ status: status('delivery_ready'), progress: 0 }).kind, 'continue')
})
test('human review stops even if work remains; lost approval is not permission to code', () => {
  assert.equal(new ExecutionContinuation().decide({ status: status('build_passed', true), progress: 0, review: 'visual' }).kind, 'approval')
  assert.equal(new ExecutionContinuation().decide({ status: status('evidence_ready'), progress: 0, review: 'scope' }).kind, 'approval')
  assert.equal(new ExecutionContinuation().decide({ status: status('scope_approved'), progress: 0 }).kind, 'blocked')
})
test('future device/build configuration must not prevent earlier engineering work', () => {
  for (const phase of ['ui_prototype_approved', 'implemented', 'wired']) assert.equal(executionEnvironmentIssue(status(phase), {}), '')
  assert.match(executionEnvironmentIssue(status('wired', true), {}), /execution.build/)
  assert.equal(executionEnvironmentIssue(status('wired', true), config), '')
  assert.match(executionEnvironmentIssue(status('build_passed', true), config), /设备/)
  assert.equal(executionEnvironmentIssue(status('build_passed', true), { ...config, device: { hdc: 'hdc' } }), '')
  assert.equal(executionEnvironmentIssue(status('functional_parity_passed', true), {}), '')
})

test('missing fixtures permit observe dismiss verify across turns without infinite stationary retry', () => {
  const current = status('build_passed', true), policy = new ExecutionContinuation()
  current.continuation = { status: 'must_continue', canEndTurn: false, reason: '', pending: [{ action: 'complete_acceptance_closeout', owner: 'agent', reason: '', condition: '', scenarios: [] }], blocked: [{ action: 'execute_required_scenarios', owner: 'agent', reason: 'fixture_not_ready', condition: '', scenarios: ['one'] }], readyScenarios: [], diagnosisScenarios: [] }
  const first = policy.decide({ status: current, progress: 1 })
  assert.equal(first.kind, 'continue')
  assert.match(first.prompt || '', /harness_device_smoke/)
  for (let i = 2; i < 12; i++) assert.equal(policy.decide({ status: current, progress: i }).kind, 'continue')
  let last = policy.decide({ status: current, progress: 12 })
  for (let i = 0; i < 9; i++) last = policy.decide({ status: current, progress: 12 })
  assert.equal(last.kind, 'blocked')
  assert.match(last.reason, /没有新证据/)
  assert.equal(new ExecutionContinuation().decide({ status: current, progress: 1, environmentIssue: '未连接设备' }).kind, 'blocked')
})

test('device progress counts changed UI rather than fresh receipt timestamps', async () => {
  const progress = new ExecutionProgress()
  let fingerprint = 'login-overlay', id = 0
  const tool = progress.observe({ definition: { name: 'harness_device_smoke', inputSchema: { type: 'object' } }, call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ result: { receipt: { status: 'completed', context: 'package', progress_fingerprint: fingerprint, operation_id: String(id++) } } }) }] }) })
  await tool.call({}); await tool.call({})
  assert.equal(progress.count, 1)
  fingerprint = 'recommendation-list'
  await tool.call({})
  assert.equal(progress.count, 2)
})

test('completed smoke still reports failed recording to continuation', async () => {
  const progress = new ExecutionProgress()
  let video = { status: 'failed', reason: 'System recorder created empty media (0 bytes)' }
  const tool = progress.observe({ definition: { name: 'harness_device_smoke', inputSchema: { type: 'object' } }, call: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ result: { receipt: { status: 'completed', context: 'package', progress_fingerprint: video.status, video } } }) }],
  }) })
  await tool.call({})
  assert.match(progress.lastError, /0 bytes/)
  assert.equal(progress.count, 1)
  const decision = new ExecutionContinuation().decide({ status: status('build_passed', true), progress: progress.count, lastError: progress.lastError })
  assert.match(decision.prompt || '', /模拟器 HDC 不支持录屏/)
  assert.match(decision.prompt || '', /recordSeconds=0/)
  assert.match(decision.prompt || '', /frame_motion/)
  assert.match(decision.prompt || '', /不要对同一录屏后端重复启动/)
  video = { status: 'recorded', reason: '' }
  await tool.call({})
  assert.equal(progress.lastError, '')
})
test('stationary responses stop with actionable context; timestamps and prose cannot reset progress', () => {
  const policy = new ExecutionContinuation(), current = status()
  for (let i = 0; i < 3; i++) assert.equal(policy.decide({ status: { ...current, checkedAt: String(i), reviewPackage: String(i) }, progress: 0 }).kind, 'continue')
  const result = policy.decide({ status: current, progress: 0, lastError: 'source_write: hash mismatch' })
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, /source_write/)
})
test('progress permits continuation but cannot evade total turn or tool budgets', () => {
  const policy = new ExecutionContinuation()
  for (let i = 0; i < 24; i++) assert.equal(policy.decide({ status: status(), progress: i }).kind, 'continue')
  assert.match(policy.decide({ status: status(), progress: 25 }).reason, /24/)
  assert.equal(new ExecutionContinuation().decide({ status: status(), progress: 1, exhausted: true }).kind, 'blocked')
  assert.match(new ExecutionContinuation().decide({ status: status('wired', true), progress: 1, environmentIssue: '缺构建命令' }).reason, /缺构建命令/)
})
test('only distinct successful source evidence counts; repeated reads, prose and errors do not', async () => {
  const progress = new ExecutionProgress()
  let fail = false
  const tool = progress.observe({ definition: { name: 'source_read', inputSchema: { type: 'object' } }, call: async () => ({ content: [{ type: 'text' as const, text: '{"sha256":"a","text":"code"}' }], isError: fail }) })
  await tool.call({ path: 'a', offset: 0 }); await tool.call({ path: 'a', offset: 0 })
  assert.equal(progress.count, 1)
  await tool.call({ path: 'a', offset: 20 }); assert.equal(progress.count, 2)
  fail = true; await tool.call({ path: 'b' }); assert.equal(progress.count, 2)
  assert.match(progress.lastError, /source_read/)
})

test('partial edits, moves and deletions are real execution progress', async () => {
  const progress = new ExecutionProgress()
  for (const name of ['source_edit', 'source_move', 'source_delete']) {
    await progress.observe({ definition: { name, inputSchema: { type: 'object' } }, call: async () => ({ content: [{ type: 'text', text: 'changed' }] }) }).call({ path: 'shared/Main.ets' })
  }
  assert.equal(progress.count, 3)
})

test('native idempotent replay and checkedAt changes are not new progress', async () => {
  const progress = new ExecutionProgress()
  let sequence = 0
  const tool = progress.observe({ definition: { name: 'harness_execution_plan', inputSchema: { type: 'object' } }, call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ result: { plan_sha256: 'a', idempotent: sequence++ > 0 }, status: { checkedAt: sequence } }) }] }) })
  await tool.call({}); await tool.call({}); await tool.call({})
  assert.equal(progress.count, 1)
})
