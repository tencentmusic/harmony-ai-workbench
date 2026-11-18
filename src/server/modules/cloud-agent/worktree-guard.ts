import { realpath } from 'node:fs/promises'
import { acquireResource } from './resource-lock'
import { CloudRecoveryError } from './domain'
import type { TaskTool } from './task-tools'

const guarded = new Set([
  'source_write', 'source_edit', 'source_delete', 'source_move', 'source_image_copy',
  'candidate_write', 'prototype_render', 'harness_start', 'harness_record',
  'harness_code_review', 'harness_build', 'harness_install', 'harness_test', 'harness_device_review',
  'harness_capture', 'harness_finalize', 'harness_execution_plan', 'harness_acceptance',
  'harness_prepare_fixtures', 'harness_device_step', 'harness_device_smoke',
])

/** Cooperative across worker processes; external editors still require snapshot checks. */
export function protectWorktreeTool(tool: TaskTool, root: string, owner: string, signal: AbortSignal): TaskTool {
  if (!guarded.has(tool.definition.name)) return tool
  return { ...tool, call: async args => {
    const canonical = await realpath(root)
    const release = await acquireResource('worktree-input', process.platform === 'win32' ? canonical.toLowerCase() : canonical, `${owner}:${tool.definition.name}`, signal)
    let uncertain = false
    try { return await tool.call(args) }
    catch (error) { uncertain = error instanceof CloudRecoveryError; throw error }
    finally { if (!uncertain) await release() }
  } }
}
