import crypto from 'crypto'
import { resolveKbVersionMeta } from './kb-version.mjs'
import { readTelemetryConfig } from './config.mjs'

export function newEventId() {
  return crypto.randomUUID()
}

export function newTraceId() {
  return crypto.randomUUID()
}

export function normalizeEvent(partial, options = {}) {
  const cfg = readTelemetryConfig(options.env)
  const kbRoot = options.kbRoot || cfg.kbRoot
  const kbMeta = resolveKbVersionMeta(kbRoot || undefined)

  const event = {
    schema_version: '1.1',
    event_id: partial.event_id || newEventId(),
    event_type: partial.event_type,
    ts: partial.ts || new Date().toISOString(),
    session: {
      trace_id: partial.session?.trace_id || options.traceId || null,
      turn_id: partial.session?.turn_id || options.turnId || null,
      parent_event_id: partial.session?.parent_event_id ?? null,
    },
    actor: {
      consumer: partial.actor?.consumer || options.consumer || cfg.consumer,
      user_hash: partial.actor?.user_hash || options.userHash || null,
      api_token_id: partial.actor?.api_token_id || options.apiTokenId || null,
    },
    kb: {
      project_id: partial.kb?.project_id || kbMeta.project_id,
      kb_version: partial.kb?.kb_version || kbMeta.kb_version,
      kb_root_hash: partial.kb?.kb_root_hash || kbMeta.kb_root_hash,
    },
    payload: partial.payload || {},
  }

  if (partial.feature_id) event.feature_id = partial.feature_id
  if (partial.payload?.feature_id && !event.feature_id) event.feature_id = partial.payload.feature_id
  if (options.featureId && !event.feature_id) event.feature_id = options.featureId

  return event
}
