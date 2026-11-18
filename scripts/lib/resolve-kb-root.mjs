import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkspaceConfig, resolveKnowledgeBase } from '@kugou/workspace-config'

const ENSURE_PORT_REL = path.join('packages', 'kb-telemetry', 'lib', 'ensure-port.mjs')

function hasKbTelemetryLib(kbRoot) {
  if (!kbRoot) return false
  return existsSync(path.join(path.resolve(kbRoot), ENSURE_PORT_REL))
}

/**
 * 解析 android-harmony-kb 根目录（需含 kb-telemetry ensure-port）。
 * 从 workspace-apps.json 解析启用的知识库。
 */
export function resolveAndroidHarmonyKbRoot(repoRoot) {
  const root = repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const config = loadWorkspaceConfig({ repoRoot: root })
  const configured = resolveKnowledgeBase('android-harmony-kb', config)?.root
  const candidates = configured ? [configured] : []

  const seen = new Set()
  for (const c of candidates) {
    const abs = path.resolve(c)
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!hasKbTelemetryLib(abs)) continue
    const normalized = abs.replace(/\\/g, '/')
    return abs
  }

  throw new Error(
    [
      '找不到 android-harmony-kb（缺少 packages/kb-telemetry/lib/ensure-port.mjs）。',
      '请检查 workspace-apps.json 的 shared_knowledge_bases.android-harmony-kb 配置。',
      `已尝试: ${[...seen].join('; ')}`,
    ].join(' '),
  )
}
