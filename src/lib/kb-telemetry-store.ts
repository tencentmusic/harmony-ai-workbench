import crypto from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { enrichOpencodeTelemetryEvents } from "@/lib/kb-telemetry-enrich-opencode";
import { prisma } from "@/lib/prisma";

type NormalizedTelemetryEvent = {
  event_id: string;
  event_type: string;
  ts: string;
  session?: { trace_id?: string | null; turn_id?: string | null };
  actor?: {
    consumer?: string;
    api_token_id?: string | null;
    person_code?: string | null;
    person_name?: string | null;
  };
  kb?: { project_id?: string | null; kb_version?: string | null };
  feature_id?: string | null;
  payload?: Record<string, unknown>;
};

function serializeRows(rows: unknown[]) {
  return JSON.parse(JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? Number(value) : value)));
}

function coerceTelemetryEvent(raw: unknown): NormalizedTelemetryEvent {
  const ev = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const session = (ev.session && typeof ev.session === "object" ? ev.session : {}) as Record<string, unknown>;
  const actor = (ev.actor && typeof ev.actor === "object" ? ev.actor : {}) as Record<string, unknown>;
  const kb = (ev.kb && typeof ev.kb === "object" ? ev.kb : {}) as Record<string, unknown>;
  const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<string, unknown>;
  const featureId =
    (ev.feature_id as string | undefined) ||
    (payload.feature_id as string | undefined) ||
    null;

  return {
    event_id: String(ev.event_id || crypto.randomUUID()),
    event_type: String(ev.event_type || "unknown"),
    ts: String(ev.ts || new Date().toISOString()),
    session: {
      trace_id: (session.trace_id as string | null | undefined) ?? null,
      turn_id: (session.turn_id as string | null | undefined) ?? null,
    },
    actor: {
      consumer: String(actor.consumer || process.env.KB_TELEMETRY_CONSUMER || "unknown"),
      api_token_id: (actor.api_token_id as string | null | undefined) ?? null,
      person_code: (actor.person_code as string | null | undefined) ?? null,
      person_name: (actor.person_name as string | null | undefined) ?? null,
    },
    kb: {
      project_id: (kb.project_id as string | null | undefined) ?? null,
      kb_version: (kb.kb_version as string | null | undefined) ?? null,
    },
    feature_id: featureId,
    payload,
  };
}

export function createTelemetryQueryClient(db: PrismaClient = prisma) {
  return {
    async query(sql: string, params: unknown[] = []) {
      const trimmed = String(sql || "").trim();
      if (/^(SELECT|WITH)/i.test(trimmed)) {
        const rows = await db.$queryRawUnsafe(trimmed, ...params);
        return { rows: serializeRows(rows as unknown[]), rowCount: 0 };
      }
      const rowCount = await db.$executeRawUnsafe(trimmed, ...params);
      return { rows: [], rowCount: Number(rowCount) };
    },
    async insertEvents(events: NormalizedTelemetryEvent[]) {
      if (!events.length) return 0;
      const data = events.map((ev) => {
        const actor = (ev.actor || {}) as Record<string, unknown>;
        const payload = {
          ...(ev.payload || {}),
          mcp_token_id:
            (ev.payload?.mcp_token_id as string | undefined) ??
            (actor.api_token_id as string | undefined) ??
            null,
          person_code:
            (ev.payload?.person_code as string | undefined) ??
            (actor.person_code as string | undefined) ??
            null,
          person_name:
            (ev.payload?.person_name as string | undefined) ??
            (actor.person_name as string | undefined) ??
            null,
          mcp_session_id:
            (ev.payload?.mcp_session_id as string | undefined) ??
            ev.session?.trace_id ??
            null,
        };
        return {
          id: ev.event_id,
          eventType: ev.event_type,
          ts: ev.ts,
          traceId: ev.session?.trace_id || (payload.mcp_session_id as string | null) || null,
          turnId: ev.session?.turn_id || null,
          consumer: ev.actor?.consumer || "unknown",
          projectId: ev.kb?.project_id || null,
          featureId: ev.feature_id || (ev.payload?.feature_id as string | undefined) || null,
          kbVersion: ev.kb?.kb_version || null,
          payloadJson: JSON.stringify(payload),
        };
      });
      const result = await db.kbTelemetryEvent.createMany({ data });
      return result.count;
    },
    async end() {
      await db.$disconnect();
    },
  };
}

export async function insertKbTelemetryEvents(rawEvents: unknown[]) {
  if (!rawEvents.length) return 0;
  let events = rawEvents.map((ev) => coerceTelemetryEvent(ev));
  events = await enrichOpencodeTelemetryEvents(events);
  const client = createTelemetryQueryClient();
  return client.insertEvents(events);
}

export async function insertKbTelemetryEventsNormalized(events: NormalizedTelemetryEvent[]) {
  if (!events.length) return 0;
  const client = createTelemetryQueryClient();
  return client.insertEvents(events);
}
