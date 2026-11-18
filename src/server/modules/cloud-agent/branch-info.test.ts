import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskBranchInfo } from './branch-info'

test('branch display uses actual workspace branch and frozen base without leaking paths', () => {
  assert.deepEqual(taskBranchInfo(JSON.stringify({ workspace: { branch: 'feature/cloud-task-2', targetBranch: 'kan-fx-release', baseSha: 'a'.repeat(40), harmonyRoot: '/private/repo' } })), {
    name: 'feature/cloud-task-2', base: 'kan-fx-release', sha: 'a'.repeat(40),
  })
  for (const value of [{}, { workspace: {} }, { workspace: { branch: '' } }]) assert.equal(taskBranchInfo(JSON.stringify(value)), null)
})
