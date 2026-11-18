import path from 'node:path'
import { prisma } from '@/lib/prisma'
import { CloudError } from './domain'
import { buildReviewPreview, readReviewBytes } from './review-preview'
import type { CloudActor } from './http'
import type { NativeReview } from './harness-review'
import type { HarnessWorkspace } from './harness'
import { approvedReviews } from './approved-reviews'

export async function downloadReviewFile(actor: CloudActor, id: string, url: URL) {
  const task = await prisma.cloudAgentTask.findFirst({ where: { id, appId: { in: actor.appIds } } })
  if (!task) throw new CloudError('任务不存在或无权限', 404)
  const saved = JSON.parse(task.harnessJson) as { review?: NativeReview; workspace?: HarnessWorkspace }
  const digest = url.searchParams.get('digest')
  const review = saved.review?.digest === digest ? saved.review : (await approvedReviews(task)).find(item => item.digest === digest)
  const workspace = saved.workspace
  if (!review || !workspace || review.digest !== url.searchParams.get('digest') || review.materialVersion !== task.materialVersion) throw new CloudError('审核版本已变化，请重新打开', 409)
  const file = review.files.find(item => item.id === url.searchParams.get('file'))
  if (!file) throw new CloudError('审核文件不存在', 404)
  const bytes = await readReviewBytes(workspace, file)
  if (url.searchParams.get('preview') === 'html') return Response.json(await buildReviewPreview(workspace, review, file, bytes), { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': file.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}` } })
}
