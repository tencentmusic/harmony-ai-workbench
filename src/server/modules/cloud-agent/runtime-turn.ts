import { record } from './domain'

export function isCompletedModelTurn(message: Record<string, unknown> | undefined) {
  if (!message) return false
  const info = record(message.info), time = record(info.time || {})
  const pendingTools = Array.isArray(message.parts) && message.parts.map(record).some(part => part.type === 'tool' && !['completed', 'error'].includes(String(record(part.state || {}).status)))
  // A provider may end with no text (including finish=unknown); text is not a liveness signal.
  return typeof time.completed === 'number' && Number.isFinite(time.completed) && !info.error && info.finish !== 'tool-calls' && !pendingTools
}
