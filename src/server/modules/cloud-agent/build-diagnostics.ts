import { open } from 'node:fs/promises'

export function buildEnvironmentDiagnostic(log: string): string | null {
  if (/The certificate has expired!|CertificateExpiredException/i.test(log)) return '鸿蒙签名证书已过期：请管理员更新本工程的 debug 签名证书及配套签名材料，再继续构建；无需重新审批需求，不能跳过签名或反复修改业务代码。'
  if (/length of path exceeds the maximum length:\s*259/i.test(log)) return 'Windows 工程或依赖路径过长：Hvigor 资源编译器拒绝超过 259 字符的路径。仅缩短构建输出不足以解决，需要在真实短路径工作树重新准备构建；已有任务不能直接改源码根目录，须保留档案并重新核验证据。'
  if (/EINVAL: invalid argument, mkdir[^\r\n]*CompileArkTS[^\r\n]*[\\/]C:/i.test(log)) return 'ArkTS 工具链生成了非法缓存路径：请检查外置依赖与工程路径配置，不能通过反复修改业务源码解决。'
  if (/maximum full path to an object file|CMAKE_OBJECT_PATH_MAX/i.test(log) && /ninja: error: mkdir|cannot be safely placed/i.test(log)) {
    return 'Windows 构建路径过长：CMake/Ninja 无法创建对象文件目录。请管理员在 execution.build.cache_root 配置专用短目录，并使用支持独立构建缓存的 Harness。无需修改业务代码或重新审批。'
  }
  if (/Invalid value of ['"]?DEVECO_SDK_HOME/i.test(log)) return 'HarmonyOS SDK 路径无效：请管理员修正 DEVECO_SDK_HOME 并重启 Worker，无需重新审批。'
  if (/ninja: error:.*oh_modules[\/\\].*missing and no known rule/i.test(log)) return 'Harmony 依赖缺失：Ninja 引用的 oh_modules 库文件不存在。请在该任务工作树的构建目录完成 OHPM 依赖安装，再继续构建；不要重新审批或反复修改业务代码。'
  return null
}

export async function readBuildEnvironmentDiagnostic(file: string) {
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const size = (await handle.stat()).size
    const bytes = Buffer.alloc(Math.min(size, 65536))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length))
    return buildEnvironmentDiagnostic(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}
