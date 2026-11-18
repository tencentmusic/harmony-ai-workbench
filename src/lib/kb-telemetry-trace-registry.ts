import fs from "node:fs";
import path from "node:path";

type TraceBinding = {
  traceId: string;
  turnId: string;
  consumer?: string;
  chatSessionId?: string | null;
  featureId?: string | null;
  featureIds?: string[];
  apiTokenId?: string | null;
};

function spoolDir() {
  return (
    String(process.env.KB_TELEMETRY_SPOOL_DIR || "").trim() ||
    path.join(process.env.HOME || process.env.USERPROFILE || ".", ".kb-telemetry", "spool")
  );
}

function registryPath() {
  return path.join(spoolDir(), "trace-bindings.json");
}

function readAll(): Record<string, Record<string, unknown>> {
  const file = registryPath();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, Record<string, unknown>>) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function bindHostSession(hostSessionId: string, binding: TraceBinding) {
  const id = String(hostSessionId || "").trim();
  if (!id) return false;
  const all = readAll();
  all[id] = {
    trace_id: binding.traceId,
    turn_id: binding.turnId,
    consumer: binding.consumer || "workbench-bff",
    chat_session_id: binding.chatSessionId || null,
    feature_id: binding.featureId || null,
    feature_ids: Array.isArray(binding.featureIds) ? binding.featureIds : [],
    api_token_id: binding.apiTokenId || null,
    bound_at: new Date().toISOString(),
  };
  writeAll(all);
  return true;
}

export function lookupHostSession(hostSessionId: string) {
  const id = String(hostSessionId || "").trim();
  if (!id) return null;
  const hit = readAll()[id];
  if (!hit) return null;
  return {
    traceId: String(hit.trace_id || ""),
    turnId: String(hit.turn_id || ""),
    consumer: String(hit.consumer || "workbench-bff"),
    chatSessionId: (hit.chat_session_id as string | null | undefined) ?? null,
    featureId: (hit.feature_id as string | null | undefined) ?? null,
    featureIds: Array.isArray(hit.feature_ids) ? (hit.feature_ids as string[]) : [],
    apiTokenId: (hit.api_token_id as string | null | undefined) ?? null,
  };
}

export function findTraceBindingByTraceId(traceId: string) {
  const id = String(traceId || "").trim();
  if (!id) return null;
  const all = readAll();
  for (const [hostSessionId, row] of Object.entries(all)) {
    if (String(row.trace_id || "") === id) {
      return {
        hostSessionId,
        traceId: id,
        turnId: String(row.turn_id || ""),
        chatSessionId: (row.chat_session_id as string | null | undefined) ?? null,
        apiTokenId: (row.api_token_id as string | null | undefined) ?? null,
      };
    }
  }
  return null;
}

export function unbindHostSession(hostSessionId: string) {
  const id = String(hostSessionId || "").trim();
  if (!id) return;
  const all = readAll();
  delete all[id];
  writeAll(all);
}

/** MCP 子进程无 OpenCode session 时，回退到最近绑定的 trace（单并发开发场景）。 */
export function resolveActiveTelemetryTrace(maxAgeMs = 45 * 60 * 1000) {
  const all = readAll();
  const entries = Object.entries(all)
    .map(([hostSessionId, row]) => ({
      hostSessionId,
      traceId: String(row.trace_id || ""),
      turnId: String(row.turn_id || ""),
      boundAt: Date.parse(String(row.bound_at || "")) || 0,
    }))
    .filter((e) => e.traceId && e.turnId && e.boundAt > 0)
    .sort((a, b) => b.boundAt - a.boundAt);

  const latest = entries[0];
  if (!latest) return null;
  if (Date.now() - latest.boundAt > maxAgeMs) return null;
  return { traceId: latest.traceId, turnId: latest.turnId, hostSessionId: latest.hostSessionId };
}
