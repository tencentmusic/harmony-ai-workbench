import fs from 'fs'
import path from 'path'

import { isValidOpencodeSessionId } from '@/lib/opencode/opencode-session'

export type AgentBackend = 'opencode'

export function getAgentWorkspaceCwd(): string {
  const fromEnv = process.env.OPENCODE_AGENT_CWD?.trim()
  const resolved = path.resolve(
    fromEnv || path.join(process.cwd(), '.runtime', 'harmony-opencode-workspace'),
  )
  if (!fs.existsSync(resolved)) throw new Error('agent_workspace_cwd_missing')
  return resolved
}

export function resolveAgentBackend(): AgentBackend {
  return 'opencode'
}

export function parseAgentSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return isValidOpencodeSessionId(id) ? id : null
}

export function agentBackendLabel(): string {
  return 'OpenCode'
}
