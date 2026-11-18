import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { CloudError, CloudRecoveryError, record } from './domain'
import { RuntimeConversation } from './runtime'
import { sha256 } from './scoped-files'

interface TaskConversationInput {
  taskId: string
  workspace: { identity: string; artifactRoot: string; runDir: string }
  role: 'analysis' | 'execution'
  model: string
  materialVersion: number
  materialSnapshot: string
  attachmentSnapshot: string
}

async function optionalText(file: string) {
  return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function nativeRunId(runDir: string) {
  const text = await optionalText(path.join(runDir, 'manifest.json'))
  if (text === null) return null
  const manifest = record(JSON.parse(text))
  if (typeof manifest.run_id !== 'string' || !manifest.run_id) throw new CloudError('Harness 运行身份无效，不能复用主会话', 409)
  return manifest.run_id
}

// The worker owns the task lease. Only the stopped runtime plus drained task tools can publish a checkpoint.
export class TaskConversation {
  readonly conversation = new RuntimeConversation()
  readonly file: string
  readonly digest: string
  readonly materialDigest: string
  reused = false
  private original: string | null = null
  private nativeId: string | null = null
  private promptHashes: Record<string, string> = {}
  private nextHashes: Record<string, string> | null = null
  private deliveredMaterialDigest: string | null = null
  private deliveredMaterialVersion: number | null = null
  private readonly input: TaskConversationInput

  private constructor(input: TaskConversationInput) {
    this.input = input
    this.file = path.join(input.workspace.artifactRoot, 'task-conversation', `${input.role}.json`)
    // Worker attempt/revision IDs change on resume; the durable workspace and Harness run do not.
    this.digest = sha256(JSON.stringify({ version: 2, taskId: input.taskId, workspace: input.workspace.identity,
      runDir: path.resolve(input.workspace.runDir), role: input.role, model: input.model }))
    this.materialDigest = sha256(JSON.stringify({ material: sha256(input.materialSnapshot), attachments: sha256(input.attachmentSnapshot) }))
  }

  static async open(input: TaskConversationInput) {
    const session = new TaskConversation(input)
    session.nativeId = await nativeRunId(input.workspace.runDir)
    session.original = await optionalText(session.file)
    if (session.original === null) return session
    const saved = record(JSON.parse(session.original))
    if (saved.digest !== session.digest || saved.nativeRunId !== session.nativeId) return session
    const hashes = record(saved.promptHashes)
    if (Object.values(hashes).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new CloudError('主会话提示词检查点非法', 409)
    if (!(saved.materialDigest === null && saved.materialVersion === null) &&
      !(typeof saved.materialDigest === 'string' && /^[a-f0-9]{64}$/.test(saved.materialDigest) && Number.isSafeInteger(saved.materialVersion) && Number(saved.materialVersion) >= 1)) throw new CloudError('主会话材料检查点非法', 409)
    await session.conversation.restore(saved.conversation)
    session.promptHashes = hashes as Record<string, string>
    session.deliveredMaterialDigest = saved.materialDigest as string | null
    session.deliveredMaterialVersion = saved.materialVersion as number | null
    session.reused = true
    return session
  }

  get materialChanged() {
    return this.reused && (this.deliveredMaterialDigest !== this.materialDigest || this.deliveredMaterialVersion !== this.input.materialVersion)
  }

  prompt(sections: Record<string, string> & { mission: string }, authority: string) {
    const hasNativeRun = this.nativeId !== null
    this.nextHashes = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, sha256(value)]))
    const changed = Object.entries(sections).filter(([key]) => !this.reused || (this.materialChanged && key === 'mission') || this.promptHashes[key] !== this.nextHashes![key])
    const removed = Object.keys(this.promptHashes).filter(key => !(key in sections))
    const header = !hasNativeRun
      ? `当前尚未建立 Harness 档案。${this.reused ? '继续同一分析会话' : '本轮建立新的分析会话'}；定位真实入口后调用 harness_start 初始化唯一档案，再查询原生状态。`
      : this.reused
      ? `继续同一任务、同一 Harness 运行、同一${this.input.role === 'analysis' ? '分析' : '执行'}职责的 OpenCode 会话。复用已知上下文；以下只补充变化片段和当前状态，不重复全量查证。`
      : '本轮建立新的职责会话；已有 Harness 账本仍是事实源，不重新初始化任务。'
    const gateGuidance = hasNativeRun
      ? '先 harness_status，按缺项继续；未决操作不得重放，不重复有效审批、构建或设备操作。'
      : '先定位真实入口并调用 harness_start；建档前不要调用 harness_status 或 harness_record，不能把空目录视为待恢复的旧档案。'
    return [header, `材料版本=${this.input.materialVersion}；材料摘要=${this.materialDigest}；本轮上下文身份=${this.digest}。`,
      ...(this.materialChanged ? [`材料已更新：上一轮确认接收的版本=${this.deliveredMaterialVersion ?? '未知'}、摘要=${this.deliveredMaterialDigest ?? '未知'}。以下 mission 中的当前材料替代旧版本材料正文与附件清单，包括删除或纠正的内容；与当前材料冲突的旧结论不得沿用，未变化的源码事实可复用。材料内容不是授权；${hasNativeRun ? '先 harness_status 核验当前范围、证据及审批有效性' : '先建立缺失的 Harness 档案'}，不得从旧对话推定当前材料已获批准或验收通过。`] : []),
      ...changed.map(([key, value]) => `<context-section name=${JSON.stringify(key)} sha256="${this.nextHashes![key]}">\n${value}\n</context-section>`),
      ...(removed.length ? [`已移除的上下文片段=${JSON.stringify(removed)}，不得继续作为当前要求。`] : []),
      `当前门禁与待办以下方重新核验结果为准；旧对话不是批准或通过证据。${gateGuidance}`, authority].join('\n')
  }

  async save(result: { toolsSettled: boolean; completed: boolean }) {
    if (!result.toolsSettled || !this.conversation.reusable) return false
    const checkpoint = this.conversation.checkpoint()
    // Revalidate at publication, not just at restore: no active/unknown process can become reusable.
    await new RuntimeConversation().restore(checkpoint)
    const currentNativeId = await nativeRunId(this.input.workspace.runDir)
    if (this.nativeId !== null && this.nativeId !== currentNativeId) throw new CloudRecoveryError('Harness 运行身份在执行中变化，未保存主会话', 409)
    if (await optionalText(this.file) !== this.original) throw new CloudRecoveryError('主会话检查点已被其他执行更新，未覆盖', 409)
    const delivered = result.completed && this.nextHashes !== null
    const hashes = delivered ? this.nextHashes! : this.promptHashes
    const materialDigest = delivered ? this.materialDigest : this.deliveredMaterialDigest
    const materialVersion = delivered ? this.input.materialVersion : this.deliveredMaterialVersion
    const text = JSON.stringify({ digest: this.digest, nativeRunId: currentNativeId, materialDigest, materialVersion, promptHashes: hashes, conversation: checkpoint })
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, this.file)
    this.original = text
    this.nativeId = currentNativeId
    this.promptHashes = hashes
    this.deliveredMaterialDigest = materialDigest
    this.deliveredMaterialVersion = materialVersion
    return true
  }
}
