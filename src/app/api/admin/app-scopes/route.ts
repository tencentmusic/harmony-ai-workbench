import { listAndroidAppScopes } from "@/lib/android-class-index";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  return Response.json({ items: listAndroidAppScopes().filter((x) => x.id !== "all") });
}

