#!/usr/bin/env node
import { listWorkspaceLinks, loadWorkspaceConfig } from '@kugou/workspace-config'

for (const link of listWorkspaceLinks(loadWorkspaceConfig())) {
  process.stdout.write(`${link.alias}\t${link.root}\n`)
}
