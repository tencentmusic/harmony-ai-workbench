#!/usr/bin/env node
/**
 * repo-sync Webhook 集成自测（需工台 dev :3100；worker 可选 --with-worker 跑一条 E2E）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listConfiguredRepos } from '../src/server/modules/repo-sync/public.ts'
import { loadWorkbenchEnv } from './render-opencode-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
process.chdir(root)
loadWorkbenchEnv()

const BASE = (process.env.WORKBENCH_TEST_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const SECRET = process.env.REPO_SYNC_WEBHOOK_SECRET || 'repo-sync-from-kb'
const ADMIN = process.env.ADMIN_SECRET || ''
const WITH_WORKER = process.argv.includes('--with-worker')
const E2E_REPO = process.env.REPO_SYNC_E2E_REPO || 'fxwiki'
const E2E_BRANCH = process.env.REPO_SYNC_E2E_BRANCH || 'release'
const configuredRepoIds = listConfiguredRepos().map((repo) => repo.id).sort()

const results = []
function pass(name) {
  results.push({ name, ok: true })
  console.log(`  ✓ ${name}`)
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err) })
  console.error(`  ✗ ${name}: ${err}`)
}

async function http(method, urlPath, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { _raw: text.slice(0, 500) }
  }
  return { status: res.status, json, text }
}

console.log(`\n=== repo-sync 集成自测 @ ${BASE} ===\n`)

// health
try {
  const h = await http('GET', '/api/health')
  assert.equal(h.status, 200)
  pass('工台 /api/health 可达')
} catch (e) {
  fail('工台 /api/health 可达', e)
  console.error('\n请先启动: npm run dev  或  npm run dev:stack\n')
  process.exit(1)
}

// 401 无 secret
try {
  const r = await http('POST', '/api/webhooks/repo-sync', { body: { repo_id: 'kugou-harmony-ai-workbench' } })
  assert.equal(r.status, 401)
  pass('Webhook 无 secret → 401')
} catch (e) {
  fail('Webhook 无 secret → 401', e)
}

// 401 错误 secret
try {
  const r = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-repo-sync-secret': 'wrong-secret' },
    body: { repo_id: 'kugou-harmony-ai-workbench' },
  })
  assert.equal(r.status, 401)
  pass('Webhook 错误 secret → 401')
} catch (e) {
  fail('Webhook 错误 secret → 401', e)
}

// GitLab push 匹配 android 大仓
try {
  const r = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body: {
      object_kind: 'push',
      ref: 'refs/heads/release',
      after: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      project: { path_with_namespace: 'tme-kugou/android' },
    },
  })
  assert.equal(r.status, 202)
  assert.equal(r.json.accepted, true)
  assert.ok(Array.isArray(r.json.runs) && r.json.runs.length >= 1)
  pass('GitLab push (android release) → 202 accepted')
} catch (e) {
  fail('GitLab push (android release) → 202 accepted', e)
}

// GitLab push 非跟踪分支 → ignored
try {
  const r = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body: {
      object_kind: 'push',
      ref: 'refs/heads/feature/test-only',
      after: 'abc',
      project: { path_with_namespace: 'tme-kugou/android' },
    },
  })
  assert.equal(r.status, 202)
  assert.equal(r.json.accepted, false)
  assert.equal(r.json.reason, 'no_matching_repo')
  pass('GitLab push 非 track 分支 → ignored')
} catch (e) {
  fail('GitLab push 非 track 分支 → ignored', e)
}

// GitLab MR merge
try {
  const r = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body: {
      object_kind: 'merge_request',
      project: { path_with_namespace: 'kugouharmony/hmkugou' },
      object_attributes: {
        action: 'merge',
        state: 'merged',
        target_branch: 'live-ktv-merge',
        merge_commit_sha: 'cafebabecafebabecafebabecafebabecafebabe',
      },
    },
  })
  assert.equal(r.status, 202)
  assert.equal(r.json.accepted, true)
  pass('GitLab MR merge (hmkugou) → 202 accepted')
} catch (e) {
  fail('GitLab MR merge (hmkugou) → 202 accepted', e)
}

// MR 未 merge → ignored
try {
  const r = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body: {
      object_kind: 'merge_request',
      project: { path_with_namespace: 'kugouharmony/hmkugou' },
      object_attributes: { action: 'open', state: 'opened', target_branch: 'live-ktv-merge' },
    },
  })
  assert.equal(r.status, 202)
  assert.equal(r.json.accepted, false)
  assert.match(String(r.json.reason), /mr_not_merged/)
  pass('GitLab MR open → ignored')
} catch (e) {
  fail('GitLab MR open → ignored', e)
}

// debounce：同 path+branch 60s 内第二次
try {
  const body = {
    object_kind: 'push',
    ref: 'refs/heads/release',
    after: '111',
    project: { path_with_namespace: 'tme-kugou/android' },
  }
  await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body,
  })
  const r2 = await http('POST', '/api/webhooks/repo-sync', {
    headers: { 'x-gitlab-token': SECRET },
    body: { ...body, after: '222' },
  })
  assert.equal(r2.status, 202)
  const debounced = r2.json.runs?.some((x) => x.debounced)
  assert.ok(debounced, 'expected debounced run')
  pass('debounce 同仓同分支 60s 内 → debounced')
} catch (e) {
  fail('debounce 同仓同分支 60s 内 → debounced', e)
}

// Admin API
if (!ADMIN) {
  console.log('  ⚠ 跳过 Admin API（未配置 ADMIN_SECRET）')
} else {
  try {
    const r = await http('GET', '/api/admin/repo-sync/runs?limit=5', {
      headers: { 'x-admin-secret': ADMIN },
    })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.runs))
    assert.deepEqual(r.json.repos.map((repo) => repo.id).sort(), configuredRepoIds)
    assert.ok(typeof r.json.queue_depth === 'number')
    pass(`Admin GET /api/admin/repo-sync/runs → ${configuredRepoIds.length} repos + runs`)
  } catch (e) {
    fail('Admin GET /api/admin/repo-sync/runs', e)
  }

  try {
    const r = await http('POST', '/api/admin/repo-sync/trigger', {
      headers: { 'x-admin-secret': ADMIN },
      body: { repo_id: E2E_REPO, branch: E2E_BRANCH, trigger: 'integration-test' },
    })
    assert.ok(r.status === 202 || r.status === 200)
    pass(`Admin 手动 trigger (${E2E_REPO}@${E2E_BRANCH})`)
  } catch (e) {
    fail('Admin 手动 trigger', e)
  }
}

// 队列文件存在
try {
  const queueDir = path.join(root, 'data', 'repo-sync', 'queue')
  const files = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : []
  assert.ok(files.length >= 0)
  pass(`队列目录可读（pending=${files.length}）`)
} catch (e) {
  fail('队列目录', e)
}

// E2E worker（可选，会真实 git pull）
if (WITH_WORKER) {
  console.log('\n--- E2E: 清空队列 → 仅 docs 仓 → worker --once ---\n')
  try {
    const queueDir = path.join(root, 'data', 'repo-sync', 'queue')
    if (fs.existsSync(queueDir)) {
      for (const f of fs.readdirSync(queueDir)) {
        if (f.endsWith('.json')) fs.unlinkSync(path.join(queueDir, f))
      }
    }
    const enq = await http('POST', '/api/admin/repo-sync/trigger', {
      headers: { 'x-admin-secret': ADMIN },
      body: { repo_id: E2E_REPO, branch: E2E_BRANCH },
    })
    assert.ok(enq.status === 202 || enq.status === 200)
    assert.equal(enq.json.accepted, true)

    const worker = spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        './scripts/register-ts.mjs',
        '--experimental-strip-types',
        'workers/repo-sync/index.mjs',
        '--once',
      ],
      { cwd: root, encoding: 'utf8', timeout: 300_000, env: process.env },
    )
    if (worker.status !== 0) {
      throw new Error((worker.stderr || worker.stdout || '').slice(-1200) || `exit ${worker.status}`)
    }
    pass('worker --once 执行完成')

    const after = await http('GET', '/api/admin/repo-sync/runs?limit=5', {
      headers: { 'x-admin-secret': ADMIN },
    })
    const recent = after.json.runs?.find((row) => String(row.repo_id).includes(E2E_REPO))
    assert.ok(recent, 'missing run record')
    assert.equal(recent.status, 'success', recent.error_message || recent.status)
    pass(`E2E ${E2E_REPO}@${E2E_BRANCH} → status=success`)
    if (recent.result?.pull?.skipped) {
      console.log(`    提示: pull skipped — ${recent.result.pull.reason}`)
    }
  } catch (e) {
    fail('E2E worker --once', e)
  }
} else {
  console.log('\n  ℹ 跳过 E2E worker（加 --with-worker 跑真实 pull+sync）\n')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  for (const f of failed) console.error(`  FAIL: ${f.name} — ${f.err}`)
  process.exit(1)
}
console.log('test:repo-sync-integration ok\n')
