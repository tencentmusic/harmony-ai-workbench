import path from 'path'

import { fileURLToPath } from 'url'



const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const TELEMETRY_PKG_ROOT = path.resolve(__dirname, '..')



function workbenchPublicBase(env = process.env) {

  const explicit = String(env.WORKBENCH_PUBLIC_URL || '').trim()

  if (explicit) return explicit.replace(/\/+$/, '')

  const port = env.WORKBENCH_PORT || env.PORT || '3100'

  return `http://127.0.0.1:${port}`

}



export function readTelemetryConfig(env = process.env) {

  const enabled = String(env.KB_TELEMETRY_ENABLED ?? '1') !== '0'

  const base = workbenchPublicBase(env)

  const endpoint =

    String(env.KB_TELEMETRY_ENDPOINT || '').trim() ||

    `${base}/api/kb-telemetry/v1/events`

  const queryBase =

    String(env.KB_TELEMETRY_QUERY_URL || '').trim() ||

    `${base}/api/kb-telemetry/v1`

  const apiKey = String(env.KB_TELEMETRY_API_KEY || '').trim()

  const consumer = String(env.KB_TELEMETRY_CONSUMER || 'mcp-direct').trim()

  const spoolDir =

    String(env.KB_TELEMETRY_SPOOL_DIR || '').trim() ||

    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kb-telemetry', 'spool')

  return {

    enabled,

    endpoint,

    queryBase,

    apiKey,

    consumer,

    spoolDir,

    kbRoot: path.resolve(TELEMETRY_PKG_ROOT, '../..'),

  }

}

