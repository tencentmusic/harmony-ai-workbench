import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uiCandidateIssues, uiScopeComponentIssues } from './ui-candidate'

test('UI drafts return actionable missing fields and never imply approval', () => {
  const issues = uiCandidateIssues({ status: 'incomplete_candidate', summary: 'draft', prototypes: {}, prototypeRenders: {} }, { status: 'required', states: [{ id: 'home' }] })
  assert.ok(issues.some(issue => issue.includes('decision')))
  assert.ok(issues.some(issue => issue.includes('layoutSpec')))
  assert.ok(issues.some(issue => issue.includes('prototypes/home')))
  assert.ok(issues.some(issue => issue.includes('prototypeRenders/home')))
  assert.ok(uiCandidateIssues({ decision: 'pending', summary: 'draft' }, {}).length)
})
test('complete UI and no-UI candidates have distinct applicability rules', () => {
  const candidate = { decision: 'approved', summary: 'request human review', layoutSpec: 'candidates/layout.md', visualRegions: 'candidates/regions.json', baselines: { home: 'materials/frame.png' }, prototypes: { home: 'candidates/home.html' }, prototypeRenders: { home: 'candidates/home.png' }, androidSources: { layout: 'src/layout.xml' }, androidEvidence: { layout: 'E-1' } }
  assert.deepEqual(uiCandidateIssues(candidate, { status: 'required', states: [{ id: 'home', components: [{ id: 'header' }] }] }), [])
  assert.ok(uiCandidateIssues(candidate, { status: 'required', states: [{ id: 'home', components: [] }] }).some(issue => issue.includes('重新确认')))
  assert.ok(uiCandidateIssues(candidate, { status: 'required', states: [{ id: 'home' }, { id: 'scroll' }] }).some(issue => issue.includes('scroll')))
  assert.ok(uiCandidateIssues({ decision: 'not_applicable', summary: 'skip' }, { status: 'required' }).length)
  assert.deepEqual(uiCandidateIssues({ decision: 'not_applicable', summary: 'no visible UI' }, { status: 'not_applicable' }), [])
  assert.ok(uiCandidateIssues({ ...candidate, status: 'incomplete_candidate' }, { status: 'required' }).length)
})

test('visible scope cannot be offered for initial approval without its component inventory', () => {
  assert.ok(uiScopeComponentIssues({ status: 'required', states: [{ id: 'home', components: [] }] }).length)
  assert.deepEqual(uiScopeComponentIssues({ status: 'not_applicable', states: [] }), [])
})
