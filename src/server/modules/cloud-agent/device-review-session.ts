import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { CloudError, record } from './domain'
import { ReadCoverage } from './code-review-domain'
import { RuntimeConversation } from './runtime'
import { sha256 } from './scoped-files'

export class DeviceReviewSession {
  id = randomUUID()
  elapsedMs = 0
  readonly coverage = new ReadCoverage()
  readonly conversation = new RuntimeConversation()
  readonly file: string
  readonly digest: string
  readonly evidenceDigest: string
  readonly files: Record<string, string>
  private constructor(file: string, digest: string, evidenceDigest: string, files: Record<string, string>) {
    this.file = file; this.digest = digest; this.evidenceDigest = evidenceDigest; this.files = files
  }

  static async open(workspace: { artifactRoot: string; identity: string }, model: string, evidence: unknown) {
    const input = record(evidence)
    const digest = sha256(JSON.stringify({ readerVersion: 2, identity: workspace.identity, model, run: input.run }))
    const evidenceDigest = sha256(JSON.stringify(evidence))
    const files = Object.fromEntries((Array.isArray(input.files) ? input.files : []).map((entry: unknown) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof record(entry[1]).sha256 !== 'string') throw new CloudError('设备复核文件绑定非法', 409)
      return [entry[0], String(record(entry[1]).sha256)]
    }))
    const session = new DeviceReviewSession(path.join(workspace.artifactRoot, 'device-review/checkpoint.json'), digest, evidenceDigest, files)
    const saved = record(JSON.parse(await readFile(session.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '{}'
      throw error
    })))
    if (saved.digest !== digest) return session
    if (typeof saved.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(saved.id) ||
      !Number.isSafeInteger(saved.elapsedMs) || Number(saved.elapsedMs) < 0) throw new CloudError('设备复核检查点非法', 409)
    await session.conversation.restore(saved.conversation)
    session.coverage.restore(saved.coverage)
    session.id = saved.id as ReturnType<typeof randomUUID>
    session.elapsedMs = saved.evidenceDigest === evidenceDigest ? Number(saved.elapsedMs) : 0
    if (saved.evidenceDigest !== evidenceDigest) {
      const previousFiles = record(saved.files || {})
      for (const [key] of session.coverage.snapshot().offsets) if (!files[key] || files[key] !== previousFiles[key]) session.coverage.invalidate(key)
    }
    return session
  }

  remainingMs() {
    const remaining = 60 * 60_000 - this.elapsedMs
    if (remaining <= 0) throw new CloudError('设备独立复核累计 60 分钟仍未完成，已保留会话和缺项，需诊断后续行', 409)
    return remaining
  }

  async save() {
    if (!this.conversation.reusable) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ digest: this.digest, evidenceDigest: this.evidenceDigest, files: this.files, id: this.id, elapsedMs: this.elapsedMs,
      conversation: this.conversation.checkpoint(), coverage: this.coverage.snapshot() }), { flag: 'wx' })
    await rename(temporary, this.file)
  }
}
