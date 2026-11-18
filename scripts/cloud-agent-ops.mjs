import { loadWorkbenchEnv } from './render-opencode-config.mjs'

loadWorkbenchEnv()
const { inspectCloudOperations, recoverStoppedCloudRun, retryCloudInbox, confirmCloudChildStopped, resumeCloudUiReview, relocateCloudWorktree, retryCloudNotification, manageCloudArtifacts, reconcileStoppedAcceptanceTime } = await import('../src/server/modules/cloud-agent/public.ts')
const [command = 'status', id, relative, hash, ...reason] = process.argv.slice(2)
try {
  if (command === 'status') console.log(JSON.stringify(await inspectCloudOperations(), null, 2))
  else if (command === 'artifacts-preview' && id) console.log(JSON.stringify(await manageCloudArtifacts('preview', id, undefined, relative), null, 2))
  else if (command === 'artifacts-archive' && id && relative) console.log(JSON.stringify(await manageCloudArtifacts('archive', id, relative, hash), null, 2))
  else if (command === 'artifacts-list' && id) console.log(JSON.stringify(await manageCloudArtifacts('list', id), null, 2))
  else if (command === 'artifacts-restore' && id && relative) console.log(JSON.stringify(await manageCloudArtifacts('restore', id, relative), null, 2))
  else if (command === 'recover-run' && id) console.log(await recoverStoppedCloudRun(id))
  else if (command === 'reconcile-acceptance-idle' && id && relative) console.log(JSON.stringify(await reconcileStoppedAcceptanceTime(id, relative), null, 2))
  else if (command === 'relocate-worktree' && id && relative) console.log(await relocateCloudWorktree(id, relative))
  else if (command === 'resume-ui-review' && id) console.log(await resumeCloudUiReview(id))
  else if (command === 'reconcile-ui-review' && id) console.log(await resumeCloudUiReview(id, 'reconcile'))
  else if (command === 'retry-inbox' && id) console.log(await retryCloudInbox(id))
  else if (command === 'retry-notification' && id) console.log(await retryCloudNotification(id))
  else if (command === 'confirm-child-stopped' && id && relative && hash && reason.length) console.log(await confirmCloudChildStopped(id, relative, hash, reason.join(' ')))
  else throw new Error('usage: cloud-agent:ops [status | artifacts-preview <taskId> [retentionDays] | artifacts-archive <taskId> <previewDigest> [retentionDays] | artifacts-list <taskId> | artifacts-restore <taskId> <archiveId> | recover-run <id> | reconcile-acceptance-idle <taskId> <attemptId> | relocate-worktree <taskId> <absoluteTarget> | resume-ui-review <runId> | reconcile-ui-review <runId> | retry-inbox <id> | retry-notification <id> | confirm-child-stopped <runId> <receipt> <sha256> <reason>]')
} catch (error) { console.error(error.message); process.exitCode = 1 }
