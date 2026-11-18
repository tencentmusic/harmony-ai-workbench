#!/usr/bin/env node
/**
 * 将 ~/.kb-telemetry/spool 中未上报的事件补发到工台。
 * 用法（与 Gateway 相同 env）：
 *   node packages/kb-mcp-gateway/scripts/replay-telemetry-spool.mjs
 */
import { loadGatewayEnv } from '../lib/load-env.mjs'
import { replaySpool } from '../../kb-telemetry/client/index.mjs'

loadGatewayEnv()

let total = 0
for (let i = 0; i < 200; i += 1) {
  const result = await replaySpool({ env: process.env })
  if (!result.replayed) break
  total += result.replayed
  console.log(`batch ${i + 1}:`, result)
}
console.log('replaySpool total:', total)
