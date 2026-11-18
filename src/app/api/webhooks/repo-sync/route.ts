import { authorizeRepoSyncWebhook, enqueueFromWebhookOrManual } from "@/server/modules/repo-sync/public";
import { readCloudBody, receiveCloudWebhook, cloudErrorResponse } from "@/server/modules/cloud-agent/public";

export const runtime = "nodejs";

/**
 * GitLab Push / MR Merge Webhook，或手动 body：
 * { "repo_id": "harmony-music", "branch": "live-ktv-merge", "trigger": "manual" }
 */
export async function POST(req: Request) {
  if (!authorizeRepoSyncWebhook(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await readCloudBody(req, 2_000_000);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Response.json({ error: 'invalid_body' }, { status: 400 });
    body = parsed as Record<string, unknown>;
    // Persist MR identity before acknowledging; repo-sync and translation retry independently.
    await receiveCloudWebhook(body);
  } catch (error) { return cloudErrorResponse(error); }

  const input =
    typeof body.repo_id === "string"
      ? { source: "manual" as const, repo_id: body.repo_id, branch: typeof body.branch === "string" ? body.branch : undefined, trigger: typeof body.trigger === "string" ? body.trigger : undefined }
      : { source: "gitlab" as const, body };

  const result = await enqueueFromWebhookOrManual(input);

  if (!result.accepted) {
    return Response.json(result, { status: 202 });
  }

  return Response.json(result, { status: 202 });
}
