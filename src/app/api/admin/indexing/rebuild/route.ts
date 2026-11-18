import { forceRebuildAndroidClassIndex } from "@/lib/android-class-index";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  try {
    const result = await forceRebuildAndroidClassIndex();
    return Response.json({
      ok: true,
      count: result.count,
      harmonyCount: result.harmonyCount,
      roots: result.roots,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg || "rebuild_failed" }, { status: 500 });
  }
}
