function resolveWorkbenchBase(env = process.env) {
  const port = env.WORKBENCH_PORT || env.PORT || '3100'
  return String(env.WORKBENCH_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
}

export function resolveL2ReportUrl(env = process.env) {
  const explicit = String(env.KB_L2_REPORT_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  return `${resolveWorkbenchBase(env)}/api/admin/kb-sync/l2/report`
}

async function postJson(url, body, env = process.env) {
  const adminSecret = String(env.WORKBENCH_ADMIN_SECRET || env.ADMIN_SECRET || '').trim()
  const headers = { 'Content-Type': 'application/json' }
  if (adminSecret) headers['x-admin-secret'] = adminSecret
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `http_${response.status}`)
  return data
}

export async function pushL2ReportToWorkbench(report, options = {}) {
  const env = options.env || process.env
  if (options.skipReport || env.KB_L2_REPORT_SKIP === '1') {
    return { skipped: true, reason: 'KB_L2_REPORT_SKIP' }
  }
  const adminSecret = String(env.WORKBENCH_ADMIN_SECRET || env.ADMIN_SECRET || '').trim()
  if (!adminSecret) return { skipped: true, reason: 'WORKBENCH_ADMIN_SECRET_missing' }
  const data = await postJson(resolveL2ReportUrl(env), report, env)
  return { skipped: false, ...data }
}
