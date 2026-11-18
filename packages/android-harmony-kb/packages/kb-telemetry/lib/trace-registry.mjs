import fs from 'fs'
import path from 'path'
import os from 'os'
import { readTelemetryConfig } from './config.mjs'

function registryPath(env = process.env) {
  const cfg = readTelemetryConfig(env)
  return path.join(cfg.spoolDir, 'trace-bindings.json')
}

function readAll(env = process.env) {
  const file = registryPath(env)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeAll(data, env = process.env) {
  const file = registryPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

export function bindHostSession(hostSessionId, binding, env = process.env) {
  const id = String(hostSessionId || '').trim()
  if (!id) return false
  const all = readAll(env)
  all[id] = {
    trace_id: binding.traceId,
    turn_id: binding.turnId,
    consumer: binding.consumer || 'workbench-bff',
    chat_session_id: binding.chatSessionId || null,
    feature_id: binding.featureId || null,
    feature_ids: Array.isArray(binding.featureIds) ? binding.featureIds : [],
    bound_at: new Date().toISOString(),
  }
  writeAll(all, env)
  return true
}

export function lookupHostSession(hostSessionId, env = process.env) {
  const id = String(hostSessionId || '').trim()
  if (!id) return null
  const hit = readAll(env)[id]
  if (!hit) return null
  return {
    traceId: hit.trace_id,
    turnId: hit.turn_id,
    consumer: hit.consumer,
    chatSessionId: hit.chat_session_id,
    featureId: hit.feature_id || null,
    featureIds: Array.isArray(hit.feature_ids) ? hit.feature_ids : [],
  }
}

export function readAllBindings(env = process.env) {
  return readAll(env)
}

export function unbindHostSession(hostSessionId, env = process.env) {
  const id = String(hostSessionId || '').trim()
  if (!id) return
  const all = readAll(env)
  delete all[id]
  writeAll(all, env)
}
