import { insertDocAnalyticsEvents, type DocAnalyticsIncomingEvent } from "@/lib/doc-analytics-store";
import { verifyBearer } from "@/lib/token";

export const runtime = "nodejs";

const ALLOWED_EVENTS = new Set(["page_view", "search", "ask_ai"]);

export async function POST(req: Request) {
  const tok = await verifyBearer(req.headers.get("authorization"));
  if (!tok) return new Response("Unauthorized", { status: 401 });

  let body: { events?: DocAnalyticsIncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return Response.json({ inserted: 0 });
  if (events.length > 20) return Response.json({ error: "too_many_events" }, { status: 400 });

  const normalized = events
    .filter((e) => e && ALLOWED_EVENTS.has(e.event) && typeof e.docPath === "string")
    .slice(0, 20) as DocAnalyticsIncomingEvent[];

  const result = await insertDocAnalyticsEvents(tok.id, normalized);
  return Response.json(result);
}
