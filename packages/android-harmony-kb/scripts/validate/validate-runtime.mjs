#!/usr/bin/env node
import assert from 'node:assert/strict'
import { loadWorkspaceConfig } from '@kugou/workspace-config'
import { listKnowledgeSources } from '../lib/knowledge-source-runtime.mjs'

const config = loadWorkspaceConfig()
const projects = config.projects
assert.ok(projects.length > 0, 'workspace config must contain at least one project')

for (const project of projects) {
  const result = listKnowledgeSources({ project_id: project.project_id }, { config })
  assert.ok(result.source_count > 0, `${project.project_id}: queryable manifest knowledge source missing`)
  for (const source of result.sources) {
    assert.equal(source.available, true, `${project.project_id}/${source.source_id}: ${source.error || 'knowledge source unavailable'}`)
    assert.ok(source.feature_count > 0, `${project.project_id}/${source.source_id}: knowledge manifest is empty`)
  }
}

console.log(`validate-runtime OK: ${projects.map((project) => project.project_id).join(', ')}`)
