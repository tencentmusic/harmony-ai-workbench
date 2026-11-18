import { authorizeTelemetryRequest } from "@/lib/kb-telemetry-endpoints";
import { bindHostSession, lookupHostSession } from "@/lib/kb-telemetry-trace-registry";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!authorizeTelemetryRequest(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const hostSessionId = String(body.host_session_id || body.opencode_session_id || "").trim();
  const traceId = String(body.trace_id || "").trim();
  const turnId = String(body.turn_id || "").trim();
  if (!hostSessionId || !traceId || !turnId) {
    return Response.json({ error: "missing host_session_id/trace_id/turn_id" }, { status: 400 });
  }

  bindHostSession(hostSessionId, {
    traceId,
    turnId,
    consumer: String(body.consumer || "workbench-bff"),
    chatSessionId: (body.chat_session_id as string | null | undefined) ?? null,
    featureId: (body.feature_id as string | null | undefined) ?? null,
    featureIds: Array.isArray(body.feature_ids) ? (body.feature_ids as string[]) : [],
    apiTokenId: (body.api_token_id as string | null | undefined) ?? null,
  });

  return Response.json({ ok: true, host_session_id: hostSessionId });
}

export async function GET(req: Request) {
  if (!authorizeTelemetryRequest(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const hostSessionId = String(
    url.searchParams.get("host_session_id") || url.searchParams.get("session_id") || "",
  ).trim();
  const hit = lookupHostSession(hostSessionId);
  if (!hit) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({
    trace_id: hit.traceId,
    turn_id: hit.turnId,
    consumer: hit.consumer,
    chat_session_id: hit.chatSessionId,
    feature_id: hit.featureId,
    feature_ids: hit.featureIds,
  });
}
