#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const scripts = [
  'test:integration-domain',
  'test:integration-projects',
  'test:integration-api',
  'test:integration-store',
  'test:integration-git',
  'test:integration-large-binary',
  'test:integration-image-size',
  'test:integration-opencode',
  'test:integration-opencode-cleanup',
  'test:integration-runner',
  'test:integration-recovery',
  'test:integration-worker',
  'test:integration-ui',
]

for (const script of scripts) {
  const result = spawnSync(npmCommand, ['run', script], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log('all integration tests passed')
