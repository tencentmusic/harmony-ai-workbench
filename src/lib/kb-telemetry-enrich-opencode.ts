import { prisma } from "@/lib/prisma";
import { findTraceBindingByTraceId } from "@/lib/kb-telemetry-trace-registry";

type TokenPerson = { id: string; personCode: string; personName: string };

type EnrichableEvent = {
  event_type: string;
  session?: { trace_id?: string | null; turn_id?: string | null };
  actor?: {
    consumer?: string;
    api_token_id?: string | null;
    person_code?: string | null;
    person_name?: string | null;
  };
  payload?: Record<string, unknown>;
};

const OPENCODE_CONSUMERS = new Set(["opencode-mcp", "opencode-bridge"]);

function needsTokenEnrich(ev: EnrichableEvent) {
  const consumer = String(ev.actor?.consumer || "");
  if (!OPENCODE_CONSUMERS.has(consumer) && consumer !== "mcp-direct") return false;
  const payload = ev.payload || {};
  if (payload.mcp_token_id || ev.actor?.api_token_id) return false;
  return Boolean(ev.session?.trace_id);
}

async function resolveApiTokenId(traceId: string, chatSessionId?: string | null) {
  const binding = findTraceBindingByTraceId(traceId);
  if (binding?.apiTokenId) return binding.apiTokenId;

  if (binding?.hostSessionId) {
    const byOpencode = await prisma.$queryRawUnsafe<Array<{ api_token_id: string }>>(
      `SELECT api_token_id FROM opencode_requests
       WHERE opencode_session_id = ? AND api_token_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      binding.hostSessionId,
    );
    if (byOpencode[0]?.api_token_id) return String(byOpencode[0].api_token_id);
  }

  const chatId = chatSessionId || binding?.chatSessionId;
  if (chatId) {
    const byChat = await prisma.$queryRawUnsafe<Array<{ api_token_id: string }>>(
      `SELECT api_token_id FROM opencode_requests
       WHERE chat_session_id = ? AND api_token_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      chatId,
    );
    if (byChat[0]?.api_token_id) return String(byChat[0].api_token_id);
  }

  return null;
}

async function loadTokenPersonMap(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, TokenPerson>();

  const rows = await prisma.apiToken.findMany({
    where: { id: { in: unique } },
    select: { id: true, personCode: true, personName: true },
  });

  return new Map(rows.map((r) => [r.id, { id: r.id, personCode: r.personCode, personName: r.personName }]));
}

/** 为 OpenCode MCP 事件补全 api_token_id / person_code / person_name */
export async function enrichOpencodeTelemetryEvents<T extends EnrichableEvent>(events: T[]): Promise<T[]> {
  const out = events.map((ev) => ({
    ...ev,
    actor: { ...ev.actor },
    payload: { ...(ev.payload || {}) },
  }));

  const tokenIdsToLoad = new Set<string>();

  for (let i = 0; i < out.length; i++) {
    const ev = out[i];
    const payload = ev.payload || {};
    let tokenId =
      (payload.mcp_token_id as string | undefined) ||
      (ev.actor?.api_token_id as string | undefined) ||
      null;

    if (!tokenId && needsTokenEnrich(ev)) {
      const traceId = String(ev.session?.trace_id || "").trim();
      if (traceId) {
        const binding = findTraceBindingByTraceId(traceId);
        tokenId = await resolveApiTokenId(traceId, binding?.chatSessionId);
      }
    }

    if (!tokenId) continue;

    if (!payload.mcp_token_id) {
      ev.payload = { ...payload, mcp_token_id: tokenId };
    }
    if (!ev.actor?.api_token_id) {
      ev.actor = { ...ev.actor, api_token_id: tokenId };
    }
    if (!payload.person_code) tokenIdsToLoad.add(tokenId);
  }

  if (!tokenIdsToLoad.size) return out;

  const personMap = await loadTokenPersonMap([...tokenIdsToLoad]);
  for (const ev of out) {
    const tokenId =
      (ev.payload?.mcp_token_id as string | undefined) ||
      (ev.actor?.api_token_id as string | undefined) ||
      null;
    if (!tokenId || ev.payload?.person_code) continue;
    const person = personMap.get(tokenId);
    if (!person) continue;
    ev.actor = {
      ...ev.actor,
      person_code: person.personCode,
      person_name: person.personName,
    };
    ev.payload = {
      ...ev.payload,
      person_code: person.personCode,
      person_name: person.personName,
    };
  }

  return out;
}
