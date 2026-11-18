/**
 * 可选飞书/企业微信通知（P3 stub）
 */
export async function notifyRepoSyncResult(input: {
  status: "success" | "failed";
  repoIds: string[];
  branch: string;
  error?: string;
}): Promise<void> {
  const url = String(process.env.REPO_SYNC_NOTIFY_WEBHOOK || "").trim();
  if (!url) return;
  const body = {
    msg_type: "text",
    content: {
      text: `[repo-sync] ${input.status} ${input.repoIds.join(",")} @ ${input.branch}${input.error ? `\n${input.error}` : ""}`,
    },
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[repo-sync] notify failed:", e);
  }
}
