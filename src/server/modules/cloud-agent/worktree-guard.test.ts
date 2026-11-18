import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { protectWorktreeTool } from './worktree-guard'
import { taskTool, textResult } from './task-tools'

test('worktree guard coordinates independent endpoints but allows reads and other tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-guard-'))
  const signal = new AbortController().signal
  const original = process.env.CLOUD_AGENT_RUNTIME_ROOT
  process.env.CLOUD_AGENT_RUNTIME_ROOT = root
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const tree = path.join(root, 'one'), other = path.join(root, 'two')
  await mkdir(tree); await mkdir(other)
  try {
    const review = protectWorktreeTool(taskTool('harness_code_review', '', {}, [], async () => { entered(); await pending; return textResult('review') }), tree, 'reviewer', signal)
    const running = review.call({})
    await started
    const child = await promisify(execFile)(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/register-ts.mjs', '--experimental-strip-types', '--input-type=module', '-e',
      `import { protectWorktreeTool } from './src/server/modules/cloud-agent/worktree-guard.ts';
       import { taskTool, textResult } from './src/server/modules/cloud-agent/task-tools.ts';
       const tool = protectWorktreeTool(taskTool('source_edit', '', {}, [], async () => textResult('unexpected write')), process.argv[1], 'other-process', new AbortController().signal);
       try { await tool.call({}); process.exitCode = 1; } catch (error) { if (!error.message.includes('占用')) throw error; console.log('blocked'); }`, tree,
    ], { windowsHide: true, timeout: 15000 })
    assert.match(child.stdout, /blocked/)
    for (const name of ['source_write', 'source_edit', 'source_delete', 'source_move', 'source_image_copy', 'harness_record', 'harness_build', 'candidate_write']) {
      const tool = taskTool(name, '', {}, [], async () => textResult('write'))
      await assert.rejects(protectWorktreeTool(tool, path.join(tree, '.'), 'writer', signal).call({}), /占用/)
      await protectWorktreeTool(tool, other, 'other-task', signal).call({})
    }
    await protectWorktreeTool(taskTool('source_read', '', {}, [], async () => textResult('read')), tree, 'reader', signal).call({})
    release(); await running
    await protectWorktreeTool(taskTool('source_edit', '', {}, [], async () => { throw new Error('ordinary failure') }), tree, 'writer', signal).call({}).catch(() => {})
    await protectWorktreeTool(taskTool('source_edit', '', {}, [], async () => textResult('ok')), tree, 'writer', signal).call({})
  } finally {
    release()
    if (original === undefined) delete process.env.CLOUD_AGENT_RUNTIME_ROOT; else process.env.CLOUD_AGENT_RUNTIME_ROOT = original
    await rm(root, { recursive: true, force: true })
  }
})
