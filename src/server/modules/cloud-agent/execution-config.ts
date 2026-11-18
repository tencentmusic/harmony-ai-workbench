import path from 'node:path'
import { CloudError, record, validBranch } from './domain'
import { loadWorkspaceAppsConfig } from '@/lib/workspace-apps-config'
import { tokenEnvName } from './gitlab-access'

export interface ExecutionConfig {
  build?: { cwd: string; artifact: string; command: string[]; timeoutSeconds: number; dependencies: string[]; nodePackages?: NodePackagePreparation[]; cacheRoot?: string; outputRoot?: 'worktree' | 'cache' }
  device?: { hdc: string; target?: string; ability?: string; executor?: 'native'; descriptor?: string; descriptorSha256?: string }
  androidReference?: { adb: string; target?: string; package: string }
  delivery?: { enabled: boolean; knowledgeId: string; knowledgeBranch: string; knowledgePath: string; knowledgeTargets?: string[]; transport: 'ssh-webhook' | 'api'; knowledgeMode: 'feature-wiki' | 'migration-archive'; codeTokenEnv?: string; knowledgeTokenEnv?: string }
}
export interface NodePackagePreparation { cwd: string; allowUnlocked: boolean }
export function relativeConfigPath(value: unknown, allowRoot = false): string {
  if (allowRoot && value === '.') return '.'
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f:]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.'))) throw new CloudError('执行配置必须使用安全相对路径', 503)
  return value
}
export function parseExecutionConfig(input: unknown): ExecutionConfig {
  if (input === undefined) return {}
  const raw = record(input), result: ExecutionConfig = {}
  if (raw.build) {
    const b = record(raw.build)
    if (!Array.isArray(b.command) || b.command.length < 2 || b.command.length > 40 || !b.command.every(s => typeof s === 'string' && s.length < 2000 && !/[\x00\r\n]/.test(s))) throw new CloudError('构建 command 必须是固定 argv 数组', 503)
    const timeoutSeconds = b.timeout_seconds === undefined ? 1800 : Number(b.timeout_seconds)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 7200) throw new CloudError('构建超时配置非法', 503)
    if (b.dependencies !== undefined && (!Array.isArray(b.dependencies) || b.dependencies.length > 30)) throw new CloudError('构建依赖包清单非法', 503)
    const dependencies = (b.dependencies as unknown[] | undefined || []).map(p => relativeConfigPath(p))
    if (dependencies.some(p => !/\.hsp$/i.test(p)) || new Set(dependencies).size !== dependencies.length) throw new CloudError('依赖包必须是不重复的 HSP 路径', 503)
    if (b.node_packages !== undefined && (!Array.isArray(b.node_packages) || b.node_packages.length > 10)) throw new CloudError('Node 依赖目录清单非法', 503)
    const nodePackages = ((b.node_packages || []) as unknown[]).map(value => {
      const pkg = record(value)
      if (Object.keys(pkg).some(key => !['cwd', 'allow_unlocked'].includes(key)) || pkg.allow_unlocked !== undefined && typeof pkg.allow_unlocked !== 'boolean') throw new CloudError('Node 依赖准备只接受 cwd 和 allow_unlocked', 503)
      return { cwd: relativeConfigPath(pkg.cwd, true), allowUnlocked: pkg.allow_unlocked === true }
    })
    if (new Set(nodePackages.map(item => item.cwd)).size !== nodePackages.length) throw new CloudError('Node 依赖目录重复', 503)
    if (b.cache_root !== undefined && (typeof b.cache_root !== 'string' || !path.isAbsolute(b.cache_root) || /[\x00\r\n]/.test(b.cache_root) || path.resolve(b.cache_root) === path.parse(b.cache_root).root)) throw new CloudError('构建缓存根必须是专用绝对目录，不能使用磁盘根目录', 503)
    if ((b.output_root !== undefined && (typeof b.output_root !== 'string' || !['worktree', 'cache'].includes(b.output_root))) || (b.output_root === 'cache' && !b.cache_root)) throw new CloudError('产物根 output_root 仅支持 worktree 或已配置的 cache', 503)
    result.build = { cwd: relativeConfigPath(b.cwd, true), artifact: relativeConfigPath(b.artifact), command: b.command as string[], timeoutSeconds, dependencies, nodePackages, cacheRoot: b.cache_root as string | undefined, outputRoot: b.output_root === 'cache' ? 'cache' : 'worktree' }
  }
  if (raw.device) {
    const d = record(raw.device)
    if (d.executor !== undefined && d.executor !== 'native') throw new CloudError('设备 executor 仅支持 native，外部适配器请配置 descriptor', 503)
    if (d.executor === 'native' && (d.descriptor !== undefined || d.descriptor_sha256 !== undefined)) throw new CloudError('内置和外部设备执行器不能混配', 503)
    if (typeof d.hdc !== 'string' || !path.isAbsolute(d.hdc) || /[\x00\r\n]/.test(d.hdc)) throw new CloudError('hdc 必须是执行机绝对路径', 503)
    if (d.target !== undefined && (typeof d.target !== 'string' || !/^[\w][\w.:-]{0,99}$/.test(d.target))) throw new CloudError('设备编号非法', 503)
    if (d.descriptor !== undefined && (typeof d.descriptor !== 'string' || !path.isAbsolute(d.descriptor) || typeof d.descriptor_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.descriptor_sha256))) throw new CloudError('设备执行器需要管理员路径和 SHA256', 503)
    if (d.ability !== undefined && (typeof d.ability !== 'string' || !/^[\w.:-]{1,100}$/.test(d.ability))) throw new CloudError('设备 ability 非法', 503)
    result.device = { hdc: d.hdc, target: d.target as string | undefined, ability: d.ability as string | undefined, executor: d.executor as 'native' | undefined, descriptor: d.descriptor as string | undefined, descriptorSha256: d.descriptor_sha256 as string | undefined }
  }
  if (raw.android_reference) {
    const d = record(raw.android_reference)
    if (typeof d.adb !== 'string' || !path.isAbsolute(d.adb) || /[\x00\r\n]/.test(d.adb) || typeof d.package !== 'string' || !/^[\w.]+$/.test(d.package)) throw new CloudError('Android 对照需配置 adb 绝对路径和包名', 503)
    if (d.target !== undefined && (typeof d.target !== 'string' || !/^[\w][\w.:-]{0,99}$/.test(d.target))) throw new CloudError('Android 设备编号非法', 503)
    result.androidReference = { adb: d.adb, package: d.package, target: d.target as string | undefined }
  }
  if (raw.delivery) {
    const d = record(raw.delivery)
    if (typeof d.knowledge_id !== 'string' || !/^[\w-]+$/.test(d.knowledge_id) || typeof d.knowledge_branch !== 'string' || !validBranch(d.knowledge_branch)) throw new CloudError('知识回流目标配置非法', 503)
    if (d.transport !== undefined && !['ssh-webhook', 'api'].includes(String(d.transport))) throw new CloudError('交付 transport 配置非法', 503)
    if (d.knowledge_mode !== undefined && !['feature-wiki', 'migration-archive'].includes(String(d.knowledge_mode))) throw new CloudError('知识回流模式非法', 503)
    if (d.knowledge_mode === 'feature-wiki' && (!Array.isArray(d.knowledge_targets) || d.knowledge_targets.length !== 2 || !d.knowledge_targets.every(t => typeof t === 'string' && /^[a-z][a-z0-9_]*\.(android|harmony)$/.test(t)) || !String(d.knowledge_targets[0]).endsWith('.android') || d.knowledge_targets[1] !== String(d.knowledge_targets[0]).replace(/\.android$/, '.harmony'))) throw new CloudError('功能知识回流需显式配置同一产品的 Android/Harmony knowledge_targets', 503)
    result.delivery = { enabled: d.enabled === true, knowledgeId: d.knowledge_id, knowledgeBranch: d.knowledge_branch, knowledgePath: relativeConfigPath(d.knowledge_path), knowledgeTargets: d.knowledge_mode === 'feature-wiki' ? d.knowledge_targets as string[] : undefined, transport: d.transport === 'api' ? 'api' : 'ssh-webhook', knowledgeMode: d.knowledge_mode === 'feature-wiki' ? 'feature-wiki' : 'migration-archive', codeTokenEnv: tokenEnvName(d.code_token_env), knowledgeTokenEnv: tokenEnvName(d.knowledge_token_env) }
  }
  return result
}
export function executionConfig(appId: string) {
  const config = loadWorkspaceAppsConfig()
  const raw = config.projects.flatMap(p => p.apps).find(a => a.app_id === appId)
  const execution = record(raw?.cloud_agent || {}).execution
  // Profile-specific machine paths are resolved in one place, never inferred from task materials.
  const profiles = record(record(raw?.cloud_agent || {}).execution_profiles || {})
  return parseExecutionConfig({ ...record(execution || {}), ...record(profiles[config.active_profile] || {}) })
}
