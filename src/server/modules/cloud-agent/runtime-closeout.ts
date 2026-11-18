import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { verifyHarness, type HarnessWorkspace } from './harness'
import { invokeRuntime } from './native-runtime'
import { sha256 } from './scoped-files'
import { git } from './git'
import { CloudError } from './domain'

export async function completeRuntimeCloseout(workspace: HarnessWorkspace, directory: string, operationId: string, signal: AbortSignal) {
  const { status } = await verifyHarness(workspace, signal)
  if (!status.acceptance?.configured) return
  const missing = status.acceptance.closeoutMissing.filter(item => ['normal_start', 'configuration'].includes(item))
  if (missing.length) throw new CloudError(`先通过 harness_acceptance 登记真实收尾证据：${missing.join('、')}；不能用调试注入代替正常启动`, 409)
  const documents = []
  for (const name of ['迁移范围.md', '鸿蒙迁移需求说明.md', '鸿蒙技术方案.md', '迁移验收用例.md']) {
    const file = path.join(directory, name), bytes = await readFile(file)
    if (!bytes.length) throw new CloudError('交付文档为空', 409)
    documents.push({ path: file, sha256: sha256(bytes) })
  }
  const branch = await git(workspace.harmonyRoot, ['branch', '--show-current'], signal)
  const head = await git(workspace.harmonyRoot, ['rev-parse', 'HEAD'], signal)
  const body = JSON.stringify({ branch, head, commit_status: 'task_changes_not_submitted', merge_status: 'not_merged', publication_status: 'prepared_locally_not_published', documents })
  const evidencePath = path.join(directory, 'closeout.json')
  await writeFile(evidencePath, body)
  const evidence = [{ path: evidencePath, sha256: sha256(body) }]
  for (const event of [
    { item: 'knowledge', reason: '知识产物已在任务目录准备，未发布；代码合入后由工作台创建知识回流MR', evidence: documents },
    { item: 'acceptance_report', reason: '验收报告已生成；实际通过与遗留项由原生账本判定', evidence: [documents[3]] },
    { item: 'git_delivery', reason: '已记录任务分支和提交基线，代码变更尚未提测；此记录不授权提交或合入', branch, head, commit_status: 'task_changes_not_submitted', merge_status: 'not_merged', evidence },
  ]) await invokeRuntime(workspace, 'acceptance', { kind: 'closeout', status: 'done', ...event }, `${operationId}-${event.item}`, signal)
}
