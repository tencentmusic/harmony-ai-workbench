import path from 'node:path'
import { realpath, readFile, lstat } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { CloudError, record } from './domain'
import { inProjectScope, scopedPath, sha256 } from './scoped-files'

export async function sourceRelativePath(root: string, registeredRoot: string, file: string) {
  const canonical = await realpath(root)
  const roots = [root, canonical]
  if (registeredRoot !== root) {
    if (await realpath(registeredRoot) !== canonical) throw new CloudError('历史源码根与当前工作树不一致，需运维核对；不要修改业务代码', 409)
    roots.push(registeredRoot)
  }
  const candidates = path.isAbsolute(file) ? roots.map(base => path.relative(base, file).replaceAll('\\', '/')) : [file]
  const relative = candidates.find(item => inProjectScope(item))
  if (!relative) throw new CloudError(`审查证据路径不属于当前工作树：${file}；请核对迁移路径，不要为此改业务代码`, 409)
  await scopedPath(root, relative, [''], true, true)
  return relative
}

export async function reviewSourcePaths(root: string, registeredRoot: string, traceability: Record<string, unknown>) {
  const records = (Array.isArray(traceability.changes) ? traceability.changes.map(record) : []).flatMap(change => Array.isArray(change.files) ? change.files.map(record) : [])
  const result: string[] = []
  for (const item of records) {
    if (typeof item.path !== 'string' || !item.path) throw new CloudError('审查变更缺少源码路径', 409)
    result.push(await sourceRelativePath(root, registeredRoot, item.path))
  }
  return [...new Set(result)]
}

export const isSigningFile = (file: string) => /\.(cer|p7b)$/i.test(file)

export async function readSigningMetadata(root: string, relative: string) {
  if (!isSigningFile(relative)) throw new CloudError('仅支持证书与签名描述文件')
  const file = await scopedPath(root, relative, [''], false, true)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new CloudError('签名文件大小非法')
  const bytes = await readFile(file), hash = sha256(bytes)
  let certificate: Record<string, string> | undefined
  if (/\.cer$/i.test(relative)) {
    try {
      const cert = new X509Certificate(bytes)
      certificate = { subject: cert.subject, issuer: cert.issuer, validFrom: cert.validFrom, validTo: cert.validTo, fingerprint256: cert.fingerprint256 }
    } catch { throw new CloudError('证书文件无法解析，不能当作有效签名材料', 409) }
  }
  return { relativePath: relative, sha256: hash, nextOffset: null,
    text: JSON.stringify({ path: relative, size: bytes.length, sha256: hash, certificate, signatureVerified: false, verification: 'Metadata only. Native signed build must validate certificate/profile compatibility and signature.' }) }
}
