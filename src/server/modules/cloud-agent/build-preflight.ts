import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { CloudEnvironmentError } from './domain'
import { harnessEnvironment, harnessRoot } from './harness'

const execute = promisify(execFile)

export async function checkHarmonySdkEnvironment(sdkRoot = process.env.DEVECO_SDK_HOME) {
  const usable = sdkRoot && path.isAbsolute(sdkRoot) && await stat(sdkRoot).then(info => info.isDirectory(), () => false)
  if (!usable) throw new CloudEnvironmentError('构建环境预检失败：DEVECO_SDK_HOME 未配置或不是有效的 SDK 绝对目录。请管理员配置 HarmonyOS SDK 根目录并重启 Worker 后继续；无需重新审批。', 503)
}

// Use the native validator without starting Hvigor, writing a receipt or moving old outputs.
export async function checkBuildEnvironment(harmonyRoot: string, command: string[], signal: AbortSignal) {
  const code = `import json,runpy,sys
api=runpy.run_path(sys.argv[1])
try:
 api['normalized_hvigor_command'](json.loads(sys.argv[3]),sys.argv[2])
 print(json.dumps({'ok':True}))
except (api['HarnessError'],OSError,ValueError) as error:
 print(json.dumps({'ok':False,'message':str(error)}))`
  const result = await execute(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', '-c', code, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), harmonyRoot, JSON.stringify(command)],
    { signal, env: harnessEnvironment(), windowsHide: true, timeout: 30000, maxBuffer: 100000 })
  const checked: unknown = JSON.parse(result.stdout)
  if (!checked || typeof checked !== 'object' || !('ok' in checked)) throw new Error('构建预检返回无效')
  if (checked.ok === true) return
  const detail = 'message' in checked && typeof checked.message === 'string' ? checked.message.slice(0, 1000) : '原生校验未通过'
  throw new CloudEnvironmentError(`构建环境预检失败，尚未启动编译。请管理员核对 workspace-apps.json 的 execution.build.command 和执行机 DEVECO_HOME（DevEco 安装目录），更新配置并重启 Worker 后继续；无需重新审批。同批次不重复构建。原生原因：${detail}`, 503)
}

export function buildPreflightGuard(check: () => Promise<void>) {
  let failure: CloudEnvironmentError | undefined
  return async () => {
    if (failure) throw failure
    try { await check() } catch (error) {
      // A batch uses fixed administrator configuration. Transient errors/aborts are never cached.
      if (error instanceof CloudEnvironmentError) failure = error
      throw error
    }
  }
}
