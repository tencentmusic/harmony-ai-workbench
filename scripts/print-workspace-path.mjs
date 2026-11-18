#!/usr/bin/env node
import {
  loadWorkspaceConfig,
  resolveDocument,
  resolveKnowledgeBase,
  resolveProjectSource,
} from '@kugou/workspace-config'

const [kind, first, second] = process.argv.slice(2)
const config = loadWorkspaceConfig()
let value = ''

if (kind === 'source') value = resolveProjectSource(first, second, config)?.resolved_path || ''
if (kind === 'knowledge-base') value = resolveKnowledgeBase(first, config)?.root || ''
if (kind === 'document') value = resolveDocument(first, second, config)?.root || ''
if (kind === 'document-repository') value = resolveDocument(first, second, config)?.repository_root || ''

if (!value) {
  console.error(`workspace_path_missing:${kind}:${first || ''}:${second || ''}`)
  process.exit(1)
}
process.stdout.write(value)
