import { resolveMcpAuditConsumerFilter } from "@/lib/kb-mcp-audit-constants";
import { createTelemetryQueryClient } from "@/lib/kb-telemetry-store";

export {
  MCP_AUDIT_CONSUMERS,
  MCP_AUDIT_QUERY_CONSUMERS,
  MCP_CONSUMER_LABELS,
  MCP_ZC_CONSUMERS,
  resolveMcpAuditConsumerFilter,
} from "@/lib/kb-mcp-audit-constants";

export type KbMcpAuditQuery = {
  days?: number;
  since?: string;
  until?: string;
  consumer?: string;
  apiTokenId?: string;
  personCode?: string;
  tool?: string;
  eventType?: string;
  mcpSessionId?: string;
  hit?: boolean | null;
  limit?: number;
  offset?: number;
};

export type KbMcpAuditRow = {
  id: string;
  eventType: string;
  ts: string;
  consumer: string;
  traceId: string | null;
  turnId: string | null;
  projectId: string | null;
  featureId: string | null;
  toolName: string | null;
  mcpTokenId: string | null;
  personCode: string | null;
  personName: string | null;
  mcpSessionId: string | null;
  hit: boolean | null;
  latencyMs: number | null;
  error: string | null;
  querySymbol: string | null;
  payload: Record<string, unknown>;
};

export type KbMcpAuditResult = {
  total: number;
  limit: number;
  offset: number;
  days: number;
  filters: Record<string, unknown>;
  byTool: Array<{ tool: string; count: number }>;
  byConsumer: Array<{ consumer: string; count: number }>;
  items: KbMcpAuditRow[];
};

const MCP_EVENT_TYPES = ["kb.tool_call", "kb.graph_query", "kb.match_attempt", "kb.context_served"] as const;

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, days));
  return d.toISOString();
}

function parseHit(raw: string | null): boolean | null {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

export function parseKbMcpAuditSearchParams(url: URL): KbMcpAuditQuery {
  return {
    days: Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 7))),
    since: url.searchParams.get("since") || undefined,
    until: url.searchParams.get("until") || undefined,
    consumer: url.searchParams.get("consumer") || undefined,
    apiTokenId: url.searchParams.get("apiTokenId") || url.searchParams.get("tokenId") || undefined,
    personCode: url.searchParams.get("personCode") || undefined,
    tool: url.searchParams.get("tool") || undefined,
    eventType: url.searchParams.get("eventType") || undefined,
    mcpSessionId: url.searchParams.get("mcpSessionId") || url.searchParams.get("sessionId") || undefined,
    hit: parseHit(url.searchParams.get("hit")),
    limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50))),
    offset: Math.max(0, Number(url.searchParams.get("offset") || 0)),
  };
}

function rowFromDb(raw: Record<string, unknown>): KbMcpAuditRow {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(raw.payloadJson || "{}")) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const hitRaw = payload.hit;
  return {
    id: String(raw.id || ""),
    eventType: String(raw.eventType || ""),
    ts: String(raw.ts || ""),
    consumer: String(raw.consumer || ""),
    traceId: raw.traceId ? String(raw.traceId) : null,
    turnId: raw.turnId ? String(raw.turnId) : null,
    projectId: raw.projectId ? String(raw.projectId) : null,
    featureId: raw.featureId ? String(raw.featureId) : null,
    toolName: payload.tool_name ? String(payload.tool_name) : null,
    mcpTokenId: payload.mcp_token_id ? String(payload.mcp_token_id) : null,
    personCode: payload.person_code ? String(payload.person_code) : null,
    personName: payload.person_name ? String(payload.person_name) : null,
    mcpSessionId: payload.mcp_session_id
      ? String(payload.mcp_session_id)
      : raw.traceId
        ? String(raw.traceId)
        : null,
    hit: typeof hitRaw === "boolean" ? hitRaw : hitRaw == null ? null : Boolean(hitRaw),
    latencyMs: payload.latency_ms != null ? Number(payload.latency_ms) : null,
    error: payload.error ? String(payload.error) : null,
    querySymbol: payload.query_symbol ? String(payload.query_symbol) : null,
    payload,
  };
}

export async function queryKbMcpAudit(input: KbMcpAuditQuery): Promise<KbMcpAuditResult> {
  const client = createTelemetryQueryClient();
  const days = input.days ?? 7;
  const since = input.since || isoDaysAgo(days);
  const until = input.until || null;
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const consumer = input.consumer?.trim() || null;
  const apiTokenId = input.apiTokenId || null;
  const personCode = input.personCode || null;
  const tool = input.tool ? `%${input.tool}%` : null;
  const eventType = input.eventType || null;
  const mcpSessionId = input.mcpSessionId || null;
  const hit = input.hit ?? null;

  const hitFilter =
    hit === null ? null : hit ? "true" : "false";

  const consumerFilter = resolveMcpAuditConsumerFilter(consumer);
  const consumerInClause =
    consumerFilter.length === 1
      ? "consumer = ?"
      : `consumer IN (${consumerFilter.map(() => "?").join(", ")})`;

  const baseWhere = `
    ts >= ?
    AND (? IS NULL OR ts <= ?)
    AND event_type IN (${MCP_EVENT_TYPES.map(() => "?").join(", ")})
    AND ${consumerInClause}
    AND (? IS NULL OR json_extract(payload_json, '$.mcp_token_id') = ?)
    AND (? IS NULL OR json_extract(payload_json, '$.person_code') = ?)
    AND (? IS NULL OR json_extract(payload_json, '$.tool_name') LIKE ?)
    AND (? IS NULL OR event_type = ?)
    AND (
      ? IS NULL OR json_extract(payload_json, '$.mcp_session_id') = ?
      OR ? IS NULL OR trace_id = ?
    )
    AND (? IS NULL OR json_extract(payload_json, '$.hit') = json(?))
  `;

  const params = [
    since,
    until,
    until,
    ...MCP_EVENT_TYPES,
    ...(consumerFilter.length === 1 ? [consumerFilter[0]] : [...consumerFilter]),
    apiTokenId,
    apiTokenId,
    personCode,
    personCode,
    tool,
    tool,
    eventType,
    eventType,
    mcpSessionId,
    mcpSessionId,
    mcpSessionId,
    mcpSessionId,
    hitFilter,
    hitFilter,
  ];

  const countSql = `SELECT COUNT(*) AS cnt FROM kb_telemetry_events WHERE ${baseWhere}`;
  const countRes = await client.query(countSql, params);
  const total = Number((countRes.rows[0] as { cnt?: number })?.cnt || 0);

  const listSql = `
    SELECT id, event_type AS eventType, ts, consumer, trace_id AS traceId, turn_id AS turnId,
           project_id AS projectId, feature_id AS featureId, payload_json AS payloadJson
    FROM kb_telemetry_events
    WHERE ${baseWhere}
    ORDER BY ts DESC
    LIMIT ? OFFSET ?
  `;
  const listRes = await client.query(listSql, [...params, limit, offset]);
  const items = (listRes.rows as Record<string, unknown>[]).map(rowFromDb);

  const byToolSql = `
    SELECT COALESCE(json_extract(payload_json, '$.tool_name'), '(unknown)') AS tool, COUNT(*) AS count
    FROM kb_telemetry_events
    WHERE ${baseWhere}
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 30
  `;
  const byToolRes = await client.query(byToolSql, params);

  const byConsumerSql = `
    SELECT consumer, COUNT(*) AS count
    FROM kb_telemetry_events
    WHERE ${baseWhere}
    GROUP BY consumer
    ORDER BY count DESC
    LIMIT 20
  `;
  const byConsumerRes = await client.query(byConsumerSql, params);

  return {
    total,
    limit,
    offset,
    days,
    filters: {
      since,
      until,
      consumer,
      apiTokenId,
      personCode,
      tool: input.tool || null,
      eventType,
      mcpSessionId,
      hit,
    },
    byTool: (byToolRes.rows as Array<{ tool: string; count: number }>).map((r) => ({
      tool: String(r.tool),
      count: Number(r.count) || 0,
    })),
    byConsumer: (byConsumerRes.rows as Array<{ consumer: string; count: number }>).map((r) => ({
      consumer: String(r.consumer),
      count: Number(r.count) || 0,
    })),
    items,
  };
}
