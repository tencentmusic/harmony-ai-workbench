import { CloudError, CloudTransientError } from './domain'
import { readBoundedJson } from './response'

export class GitLabTransientError extends CloudTransientError {}
export type GitLabRequest = (origin: string, endpoint: string, signal: AbortSignal, body?: unknown) => Promise<unknown>

export function tokenEnvName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 100 || !/^CLOUD_AGENT_GITLAB_(?:[A-Z0-9_]+_)?TOKEN$/.test(value) || /\s/.test(value)) throw new CloudError('GitLab 凭据必须引用 CLOUD_AGENT_GITLAB_*_TOKEN 环境变量名，不能填写密钥', 503)
  return value
}

export function gitlabRequestFor(tokenEnv?: string): GitLabRequest {
  const name = tokenEnvName(tokenEnv) || 'CLOUD_AGENT_GITLAB_TOKEN'
  return async (origin, endpoint, signal, body) => {
    signal.throwIfAborted()
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || !/^\/projects\/[^/]+\/merge_requests(?:\/\d+)?(?:\?.*)?$/.test(endpoint)) throw new CloudError('GitLab API 地址非法', 503)
    const token = process.env[name]?.trim()
    if (!token) throw new CloudError(`缺少 ${name}；请配置对应仓库权限后重试`, 503)
    let response: Response
    try {
      response = await fetch(`${origin}/api/v4${endpoint}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch {
      signal.throwIfAborted()
      throw new GitLabTransientError('GitLab 连接超时或暂时不可用，保留快照自动重试', 503)
    }
    if (!response.ok) {
      await response.body?.cancel()
      if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new GitLabTransientError(`GitLab 暂时不可用（${response.status}），保留快照自动重试`, 503)
      throw new CloudError(`GitLab 请求失败（${response.status}）；请核对 ${name} 的仓库权限及 MR 状态`, 503)
    }
    try { return await readBoundedJson(response, 2_000_000) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof CloudError) throw error
      throw new GitLabTransientError('GitLab 响应未完整读取，保留快照并重新核验', 503)
    }
  }
}
