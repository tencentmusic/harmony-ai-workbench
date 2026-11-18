import { authorizeTelemetryRequest } from "@/lib/kb-telemetry-endpoints";
import { insertKbTelemetryEvents } from "@/lib/kb-telemetry-store";
import { resolveActiveTelemetryTrace } from "@/lib/kb-telemetry-trace-registry";

export const runtime = "nodejs";

function enrichTelemetryEvents(events: unknown[]) {
  const active = resolveActiveTelemetryTrace();
  if (!active) return events;

  return events.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const ev = raw as Record<string, unknown>;
    const session =
      ev.session && typeof ev.session === "object"
        ? (ev.session as Record<string, unknown>)
        : {};
    const traceId = String(session.trace_id || "").trim();
    const turnId = String(session.turn_id || "").trim();
    if (traceId && turnId) return ev;

    const actor = ev.actor && typeof ev.actor === "object" ? (ev.actor as Record<string, unknown>) : {};
    const consumer = String(actor.consumer || "");
    const eventType = String(ev.event_type || "");
    const needsTrace =
      consumer === "opencode-mcp" &&
      (eventType === "kb.graph_query" || eventType === "kb.context_served" || eventType === "kb.match_attempt");
    if (!needsTrace) return ev;

    return {
      ...ev,
      session: {
        ...session,
        trace_id: active.traceId,
        turn_id: active.turnId,
      },
    };
  });
}

export async function POST(req: Request) {
  if (!authorizeTelemetryRequest(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { events?: unknown[]; event?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
  if (!events.length) return Response.json({ inserted: 0 });

  try {
    const inserted = await insertKbTelemetryEvents(enrichTelemetryEvents(events));
    return Response.json({ inserted });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "insert_failed" },
      { status: 500 },
    );
  }
}
