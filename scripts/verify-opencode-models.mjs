#!/usr/bin/env node
/**
 * 本地验证 Sub2API 主模型配置（不部署测试服）。
 * 用法：node scripts/verify-opencode-models.mjs
 */
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const globalSrc = path.join(root, 'runtime/opencode/opencode.global.json')
const globalDstDir = path.join(root, '.runtime/opencode-config')
const globalDst = path.join(globalDstDir, 'opencode.json')

function loadEnvFile(rel) {
  const file = path.join(root, rel)
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx).trim()
      let val = trimmed.slice(idx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    // optional
  }
}

loadEnvFile('.env')
loadEnvFile('.env.local')
loadEnvFile('.env.production')

const globalJson = JSON.parse(readFileSync(globalSrc, 'utf8'))
const sub2apiBase =
  globalJson?.provider?.sub2api?.options?.baseURL?.replace(/\/$/, '') || 'https://model-gateway.example/v1'
const sub2apiModel =
  (typeof globalJson?.model === 'string' && globalJson.model.startsWith('sub2api/')
    ? globalJson.model.slice('sub2api/'.length)
    : null) || 'gpt-5.6-luna'

const sub2apiKey = process.env.SUB2API_API_KEY || process.env.OPENAI_API_KEY || ''
const opencodeBase = (process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4098').replace(/\/$/, '')

async function testResponses(label, url, apiKey, model, prompt = 'ping') {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${label} invalid JSON: ${text.slice(0, 200)}`)
  }
  const content =
    json?.output?.[0]?.content?.[0]?.text ??
    json?.choices?.[0]?.message?.content ??
    json?.output_text
  return { model: json?.model, content: typeof content === 'string' ? content.slice(0, 120) : String(content) }
}

async function testOpencodeConfig() {
  const res = await fetch(`${opencodeBase}/config`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`OpenCode /config HTTP ${res.status}`)
  const cfg = await res.json()
  return {
    model: cfg.model,
    small_model: cfg.small_model,
    sub2apiBase: cfg?.provider?.sub2api?.options?.baseURL,
    sub2apiModels: Object.keys(cfg?.provider?.sub2api?.models || {}),
  }
}

async function main() {
  console.log('==> 1. 写入本地 OPENCODE_CONFIG_DIR')
  mkdirSync(globalDstDir, { recursive: true })
  copyFileSync(globalSrc, globalDst)
  console.log(`    ${globalDst}`)

  console.log(`\n==> 2. Sub2API 主模型直连（${sub2apiModel} @ ${sub2apiBase}）`)
  if (!sub2apiKey) throw new Error('SUB2API_API_KEY 未设置（.env / .env.local）')
  let sub2api
  try {
    sub2api = await testResponses(
      'Sub2API responses',
      `${sub2apiBase}/responses`,
      sub2apiKey,
      sub2apiModel,
      '你好，用一句话介绍你自己',
    )
  } catch (responsesError) {
    console.log(`    responses 失败，尝试 chat/completions: ${responsesError.message}`)
    const res = await fetch(`${sub2apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sub2apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: sub2apiModel,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Sub2API chat HTTP ${res.status}: ${text.slice(0, 300)}`)
    const json = JSON.parse(text)
    sub2api = {
      model: json?.model,
      content: String(json?.choices?.[0]?.message?.content || '').slice(0, 120),
    }
  }
  console.log(`    OK model=${sub2api.model}`)
  console.log(`    reply=${sub2api.content}`)

  console.log('\n==> 3. 本地 OpenCode /config（需已启动 opencode serve :4098）')
  try {
    const oc = await testOpencodeConfig()
    console.log(`    model=${oc.model}`)
    console.log(`    sub2api.baseURL=${oc.sub2apiBase}`)
    console.log(`    sub2api.models=${oc.sub2apiModels.join(',')}`)
  } catch (e) {
    console.log(`    SKIP ${e instanceof Error ? e.message : e}`)
    console.log('    提示：先在本机启动 OpenCode（见下方命令）后再跑本脚本第 3 步')
  }

  console.log('\n✅ 模型网关验证完成（未修改测试服）')
}

main().catch((e) => {
  console.error('\n❌', e instanceof Error ? e.message : e)
  process.exit(1)
})
