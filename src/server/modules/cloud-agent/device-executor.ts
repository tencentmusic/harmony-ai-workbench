import { readFile } from 'node:fs/promises'
import type { ExecutionConfig } from './execution-config'
import { CloudError, CloudEnvironmentError, CloudRecoveryError } from './domain'
import { sha256 } from './scoped-files'

const recoveryExitCode = 75
export function deviceExecutorExitCode(error: unknown, aborted: boolean) {
  return aborted || error instanceof CloudRecoveryError ? recoveryExitCode : 1
}

export function deviceChildFailure(error: unknown, child: { exitCode: number | null; signalCode: string | null }, aborted: boolean) {
  const failure = error as { code?: unknown; killed?: boolean; signal?: string; stderr?: string }
  const uncertain = aborted || failure.killed || failure.signal || failure.code === recoveryExitCode || child.exitCode === recoveryExitCode || child.exitCode === null && child.signalCode === null
  if (uncertain) return new CloudRecoveryError('设备动作或子进程结果未确认，保留设备锁；核对进程及原生动作后恢复', 409)
  return new CloudError(`设备用例执行未通过：${failure.stderr?.slice(-2200) || '查看 executor.log'}。保留原操作与证据，不重做转译`, 409)
}

export function deviceExecutorIssue(device: ExecutionConfig['device']) {
  if (device?.executor === 'native') return ''
  if (!device?.descriptor || !device.descriptorSha256) return '正式业务验收执行器未配置：请管理员配置当前 App 的 cloud_agent.execution.device.descriptor 和 descriptor_sha256；不影响独立启动、截图与录屏取证，不能靠修改业务代码解决'
  return ''
}

export async function requireDeviceExecutor(device: ExecutionConfig['device']) {
  if (device?.executor === 'native') throw new CloudEnvironmentError('内置设备执行器不使用外部 descriptor', 503)
  const issue = deviceExecutorIssue(device)
  if (issue) throw new CloudEnvironmentError(issue, 503)
  const descriptor = device!.descriptor!
  const bytes = await readFile(descriptor).catch(() => { throw new CloudEnvironmentError('正式业务验收执行器描述文件读取失败；请管理员核对 execution.device.descriptor 路径和访问权限，不重做代码转译', 503) })
  if (sha256(bytes) !== device!.descriptorSha256) throw new CloudEnvironmentError('正式业务验收执行器描述文件指纹已变化；请管理员审核文件后更新 execution.device.descriptor_sha256，禁止自动信任新指纹', 503)
  return descriptor
}
