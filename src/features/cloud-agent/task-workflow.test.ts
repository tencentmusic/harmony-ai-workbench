import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CloudTask } from '../../contracts/cloud-agent'
import { taskWorkflow, currentTaskNode, taskRepair } from './task-workflow'

const task = { status: 'awaiting_approval', stage: 'approval', material: 'facts', attachments: [], materialVersion: 2, runs: [], review: { kind: 'scope', materialVersion: 2 }, harness: { nodes: [{ id: 'context_ready', status: 'passed' }, { id: 'evidence_ready', status: 'passed' }], blockers: [] } } as unknown as CloudTask
test('nine task nodes project native evidence, never infer passed from the current stage', () => {
  const nodes = taskWorkflow(task)
  assert.equal(nodes.length, 9)
  assert.equal(currentTaskNode(task), 'approval')
  assert.equal(nodes.find(n => n.id === 'analysis')?.status, 'passed')
  assert.equal(nodes.find(n => n.id === 'approval')?.status, 'waiting')
  assert.equal(taskWorkflow({ ...task, stage: 'device', status: 'translating' }).find(n => n.id === 'coding')?.status, 'pending')
})
test('visual approval belongs to device, ready maps to coding, stale material cannot show passed', () => {
  assert.equal(currentTaskNode({ ...task, review: { ...task.review!, kind: 'visual' } }), 'device')
  assert.equal(currentTaskNode({ ...task, stage: 'ready', status: 'approved' }), 'coding')
  assert.equal(taskWorkflow({ ...task, review: { ...task.review!, materialVersion: 1 } }).find(n => n.id === 'analysis')?.status, 'stale')
})
test('delivery link is not proof of merge or knowledge publication', () => {
  const nodes = taskWorkflow({ ...task, status: 'knowledge_review', stage: 'knowledge', delivery: { codeUrl: 'url', knowledgeUrl: 'url' } })
  assert.equal(nodes.find(n => n.id === 'integration')?.status, 'pending')
  assert.notEqual(nodes.find(n => n.id === 'knowledge')?.status, 'passed')
})

test('submission completes only the handoff node, not code merge or knowledge return', () => {
  const pending = { ...task, status: 'awaiting_merge', stage: 'integration', review: null, delivery: { integrationId: 'fixture', handoff: { status: 'pending' } } } as CloudTask
  assert.equal(taskWorkflow(pending).find(n => n.id === 'integration')?.label, '提测')
  assert.equal(taskWorkflow(pending).find(n => n.id === 'integration')?.status, 'waiting')
  const submitted = { ...pending, delivery: { ...pending.delivery, handoff: { status: 'submitted' as const } } }
  assert.equal(taskWorkflow(submitted).find(n => n.id === 'integration')?.status, 'passed')
  assert.notEqual(taskWorkflow(submitted).find(n => n.id === 'knowledge')?.status, 'passed')
})

test('an incomplete device conclusion moves to integration without marking device or knowledge passed', () => {
  const conclusion = { result: 'incomplete' as const, sourceHeadSha: 'a'.repeat(40), materialVersion: 2, verificationSha256: 'b'.repeat(64), concludedAt: '', nodes: [], blockers: [], reason: '缺少连续播放证据' }
  const projected = { ...task, status: 'device_concluded' as const, stage: 'integration' as const, review: null, deviceConclusion: conclusion }
  assert.equal(currentTaskNode(projected), 'integration')
  assert.equal(taskWorkflow(projected).find(node => node.id === 'device')?.status, 'blocked')
  assert.equal(taskWorkflow(projected).find(node => node.id === 'integration')?.status, 'waiting')
  assert.notEqual(taskWorkflow({ ...projected, status: 'completed', stage: 'knowledge' }).find(node => node.id === 'knowledge')?.status, 'passed')
})

test('build repair shows historical recheck and internal repair without passing stale gates', () => {
  const repair: CloudTask = { ...task, status: 'translating', stage: 'build', review: null, harness: { ...task.harness!, phase: 'ui_prototype_approved', lifecycle: { stage: 'build', materialVersion: 2, passedNodes: ['implemented', 'wired'], reviewPassed: true } } }
  const nodes = taskWorkflow(repair)
  assert.equal(currentTaskNode(repair), 'build')
  assert.equal(nodes.find(n => n.id === 'coding')?.status, 'recheck')
  assert.equal(nodes.find(n => n.id === 'review')?.status, 'recheck')
  assert.equal(nodes.find(n => n.id === 'build')?.status, 'current')
  assert.equal(taskRepair(repair)?.title, '构建验证 · 局部修复')
  assert.equal(taskRepair({ ...repair, status: 'harness_waiting' })?.paused, true)
  assert.equal(taskRepair({ ...repair, status: 'awaiting_approval' }), null)
  assert.equal(taskWorkflow({ ...repair, materialVersion: 3 }).find(n => n.id === 'review')?.status, 'pending')
  assert.equal(taskRepair({ ...repair, harness: { ...repair.harness!, phase: 'wired', codeReview: { status: 'running', summary: '', checks: [], findings: [] } } })?.title, '构建验证 · 代码复审')
})
