import { enqueueFromWebhookOrManual } from "@/server/modules/repo-sync/public";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const body = (await req.json().catch(() => ({}))) as { repo_id?: string; branch?: string };
  if (!body.repo_id) {
    return Response.json({ error: "repo_id_required" }, { status: 400 });
  }
  const result = await enqueueFromWebhookOrManual({
    source: "manual",
    repo_id: body.repo_id,
    branch: body.branch,
    trigger: "admin",
  });
  return Response.json(result, { status: result.accepted ? 202 : 200 });
}
