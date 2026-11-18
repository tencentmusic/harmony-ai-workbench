/**
 * Android/Harmony counterpart resolution backed by the project's manifest knowledge source.
 */
import { resolveKnowledgeCounterpart } from './knowledge-source-runtime.mjs'

export async function resolveCounterpart({
  symbol,
  from_platform: fromPlatform = 'android',
  project_id: projectId = 'demo-project',
  feature_id: featureId,
  env = process.env,
} = {}) {
  try {
    return resolveKnowledgeCounterpart({
      symbol,
      feature_id: featureId,
      from_platform: fromPlatform,
      project_id: projectId,
    }, { env })
  } catch (error) {
    return {
      hit: false,
      project_id: projectId,
      source_id: null,
      symbol: String(symbol || '').trim(),
      requested_feature_id: String(featureId || '').trim() || null,
      from_platform: fromPlatform,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Check the project knowledge target, manifest build, and code_map route coverage; then use L2/L3.',
    }
  }
}

export function formatCounterpartDirective(result) {
  if (!result?.hit) return ''
  const lines = [
    `[工台知识库 · ${result.source_id || '业务知识'}双端代码地图]`,
    `feature_id: ${result.feature_id}`,
    `Android: ${result.android.entry_simple || '-'}${result.android.entry_fqn ? ` (${result.android.entry_fqn})` : ''}`,
    `Harmony: ${result.harmonyos.entry || '-'}`,
  ]
  if (result.android.code_map_refs?.length) {
    lines.push(`Android code_map: ${result.android.code_map_refs.join(', ')}`)
  }
  if (result.harmonyos.code_map_refs?.length) {
    lines.push(`Harmony code_map: ${result.harmonyos.code_map_refs.join(', ')}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
