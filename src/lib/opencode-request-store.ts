import crypto from "crypto";
import { normalizeChatAttachments, type ChatAttachment } from "@/lib/chat-attachments-shared";
import { listAndroidAppScopes } from "@/lib/android-class-index";
import { resolveRequestedAppScopeId } from "@/lib/opencode/opencode-app-scope";
import { collectOpencodeImages, type OpencodeImageRef } from "@/lib/opencode/opencode-image";
import { prisma } from "@/lib/prisma";

/** 表结构以 prisma/schema.prisma → OpencodeRequest 为准；ensure 仅兜底。 */
export type OpencodeRequestStatus = "running" | "done" | "failed" | "canceled";

export type OpencodeRequestRecord = {
  id: string;
  apiTokenId: string;
  chatSessionId: string | null;
  opencodeSessionId: string | null;
  appScopeId: string | null;
  module: string;
  classFqn: string;
  userPrompt: string;
  modelName: string | null;
  assistantOutput: string | null;
  status: OpencodeRequestStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type OpencodeRequestAdminRow = OpencodeRequestRecord & {
  token: {
    id: string;
    personName: string;
    personCode: string;
    label: string | null;
  } | null;
  outputImages?: OpencodeImageRef[];
  userAttachments?: ChatAttachment[];
};

let initialized = false;

async function ensureOpencodeRequestTable() {
  if (initialized) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS opencode_requests (
      id TEXT PRIMARY KEY,
      api_token_id TEXT NOT NULL,
      chat_session_id TEXT,
      opencode_session_id TEXT,
      app_scope_id TEXT,
      module TEXT NOT NULL,
      class_fqn TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_output TEXT,
      model_name TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_opencode_requests_token_created ON opencode_requests(api_token_id, created_at DESC);`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_opencode_requests_status_created ON opencode_requests(status, created_at DESC);`,
  );
  initialized = true;
}

type Row = {
  id: string;
  api_token_id: string;
  chat_session_id: string | null;
  opencode_session_id: string | null;
  app_scope_id: string | null;
  module: string;
  class_fqn: string;
  user_prompt: string;
  assistant_output: string | null;
  model_name: string | null;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

function mapRow(row: Row): OpencodeRequestRecord {
  const status = row.status as OpencodeRequestStatus;
  return {
    id: row.id,
    apiTokenId: row.api_token_id,
    chatSessionId: row.chat_session_id,
    opencodeSessionId: row.opencode_session_id,
    appScopeId: row.app_scope_id,
    module: row.module,
    classFqn: row.class_fqn,
    userPrompt: row.user_prompt,
    modelName: row.model_name,
    assistantOutput: row.assistant_output,
    status,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function extractClassHintFromPrompt(prompt: string): string {
  const text = String(prompt || "").trim();
  if (!text) return "-";
  const atMatch = text.match(/@([\w.]+(?:\.[A-Z]\w*)*)/);
  if (atMatch?.[1]) return atMatch[1];
  const fqnMatch = text.match(/\b([a-z][\w.]*\.[A-Z]\w*)\b/);
  if (fqnMatch?.[1]) return fqnMatch[1];
  const simpleClass = text.match(
    /\b([A-Z][\w]*(?:Activity|Fragment|Manager|Service|View|Adapter|Helper|Utils?))\b/,
  );
  if (simpleClass?.[1]) return simpleClass[1];
  return "-";
}

export function resolveAppScopeModuleLabel(appScopeId: string, allowedScopeIds: string[]) {
  const scopes = listAndroidAppScopes();
  const sid = resolveRequestedAppScopeId(appScopeId, allowedScopeIds);
  if (sid === "all") {
    if (allowedScopeIds.length) {
      return allowedScopeIds.map((id) => scopes.find((s) => s.id === id)?.label || id).join("、");
    }
    return "全部应用";
  }
  return scopes.find((s) => s.id === sid)?.label || sid;
}

export async function resolveLatestOpencodeSessionForChatSession(opts: {
  tokenId: string;
  chatSessionId: string;
}): Promise<string | null> {
  await ensureOpencodeRequestTable();
  const rows = await prisma.$queryRawUnsafe<Array<{ opencode_session_id: string | null }>>(
    `SELECT opencode_session_id
     FROM opencode_requests
     WHERE api_token_id = ?
       AND chat_session_id = ?
       AND opencode_session_id IS NOT NULL
       AND status IN ('done', 'running')
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
    opts.tokenId,
    opts.chatSessionId,
  );
  const id = String(rows[0]?.opencode_session_id || "").trim();
  return id || null;
}

export async function tokenOwnsOpencodeSession(opts: {
  tokenId: string;
  opencodeSessionId: string;
  chatSessionId?: string | null;
}): Promise<boolean> {
  await ensureOpencodeRequestTable();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id
     FROM opencode_requests
     WHERE api_token_id = ?
       AND opencode_session_id = ?
       AND (? IS NULL OR chat_session_id = ?)
     LIMIT 1`,
    opts.tokenId,
    opts.opencodeSessionId,
    opts.chatSessionId ?? null,
    opts.chatSessionId ?? null,
  );
  return rows.length === 1;
}

function nowIso() {
  return new Date().toISOString();
}

export async function createOpencodeRequest(opts: {
  apiTokenId: string;
  chatSessionId?: string | null;
  appScopeId?: string | null;
  module: string;
  classFqn: string;
  userPrompt: string;
  modelName: string;
}): Promise<string> {
  await ensureOpencodeRequestTable();
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await prisma.$executeRawUnsafe(
    `INSERT INTO opencode_requests (
      id, api_token_id, chat_session_id, app_scope_id, module, class_fqn, user_prompt, model_name, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.apiTokenId,
    opts.chatSessionId || null,
    opts.appScopeId || null,
    opts.module,
    opts.classFqn,
    opts.userPrompt,
    opts.modelName,
    "running",
    createdAt,
  );
  return id;
}

export async function finishOpencodeRequest(opts: {
  id: string;
  status: OpencodeRequestStatus;
  assistantOutput?: string | null;
  opencodeSessionId?: string | null;
  error?: string | null;
}) {
  await ensureOpencodeRequestTable();
  const finishedAt = nowIso();
  await prisma.$executeRawUnsafe(
    `UPDATE opencode_requests
     SET status = ?, assistant_output = ?, opencode_session_id = ?, error = ?, finished_at = ?
     WHERE id = ?`,
    opts.status,
    opts.assistantOutput ?? null,
    opts.opencodeSessionId ?? null,
    opts.error ?? null,
    finishedAt,
    opts.id,
  );
}

/** 仅当仍为 running 时结束，避免旧流覆盖已 cancel/done 的记录。 */
export async function finishOpencodeRequestIfRunning(opts: {
  id: string;
  status: OpencodeRequestStatus;
  assistantOutput?: string | null;
  opencodeSessionId?: string | null;
  error?: string | null;
}): Promise<boolean> {
  await ensureOpencodeRequestTable();
  const finishedAt = nowIso();
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE opencode_requests
     SET status = ?, assistant_output = ?, opencode_session_id = ?, error = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
    opts.status,
    opts.assistantOutput ?? null,
    opts.opencodeSessionId ?? null,
    opts.error ?? null,
    finishedAt,
    opts.id,
  );
  return Number(affected) > 0;
}

export async function updateOpencodeRequestProgress(opts: {
  id: string;
  assistantOutput?: string | null;
  opencodeSessionId?: string | null;
}) {
  await ensureOpencodeRequestTable();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (opts.assistantOutput !== undefined) {
    sets.push("assistant_output = ?");
    params.push(opts.assistantOutput);
  }
  if (opts.opencodeSessionId !== undefined) {
    sets.push("opencode_session_id = ?");
    params.push(opts.opencodeSessionId);
  }
  if (!sets.length) return;
  params.push(opts.id);
  await prisma.$executeRawUnsafe(
    `UPDATE opencode_requests SET ${sets.join(", ")} WHERE id = ? AND status = 'running'`,
    ...params,
  );
}

export async function getActiveOpencodeRequestForChatSession(opts: {
  chatSessionId: string
  tokenId: string
}): Promise<OpencodeRequestRecord | null> {
  await ensureOpencodeRequestTable()
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, api_token_id, chat_session_id, opencode_session_id, app_scope_id, module, class_fqn,
            user_prompt, assistant_output, model_name, status, error, created_at, finished_at
     FROM opencode_requests
     WHERE chat_session_id = ? AND api_token_id = ? AND status = 'running'
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
    opts.chatSessionId,
    opts.tokenId,
  )
  const row = rows[0]
  if (!row) return null

  const record = mapRow(row)
  const ageMs = Date.now() - new Date(record.createdAt).getTime()
  const hasOutput = !!record.assistantOutput?.trim()
  const staleMaxMs = 15 * 60 * 1000
  const staleEmptyMs = 2 * 60 * 1000
  const stale = ageMs > staleMaxMs || (!hasOutput && ageMs > staleEmptyMs)

  if (stale) {
    await finishOpencodeRequest({
      id: record.id,
      status: 'failed',
      assistantOutput: record.assistantOutput,
      opencodeSessionId: record.opencodeSessionId,
      error: 'stale_run',
    })
    return null
  }

  return record
}

export async function cancelActiveOpencodeRequestForChatSession(opts: {
  chatSessionId: string
  tokenId: string
}): Promise<boolean> {
  await ensureOpencodeRequestTable()
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, assistant_output, opencode_session_id
     FROM opencode_requests
     WHERE chat_session_id = ? AND api_token_id = ? AND status = 'running'
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
    opts.chatSessionId,
    opts.tokenId,
  )
  const row = rows[0]
  if (!row) return false
  await finishOpencodeRequest({
    id: row.id,
    status: 'canceled',
    assistantOutput: row.assistant_output,
    opencodeSessionId: row.opencode_session_id,
    error: 'user_canceled',
  })
  return true
}

/** 进程启动时清理全部 running（reload 后旧任务已不存在）。 */
export async function failRunningOpencodeRequestsOnStartup() {
  await ensureOpencodeRequestTable()
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; assistant_output: string | null; opencode_session_id: string | null }>>(
    `SELECT id, assistant_output, opencode_session_id FROM opencode_requests WHERE status = 'running'`,
  )
  for (const row of rows) {
    await finishOpencodeRequest({
      id: row.id,
      status: 'failed',
      assistantOutput: row.assistant_output,
      opencodeSessionId: row.opencode_session_id,
      error: 'server_restarted',
    })
  }
  return rows.length
}

/** 清理卡死的 running 记录。 */
export async function expireStaleOpencodeRequestsForToken(tokenId: string) {
  await ensureOpencodeRequestTable()
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; assistant_output: string | null; opencode_session_id: string | null; created_at: string }>
  >(
    `SELECT id, assistant_output, opencode_session_id, created_at
     FROM opencode_requests
     WHERE api_token_id = ? AND status = 'running'`,
    tokenId,
  )
  const now = Date.now()
  for (const row of rows) {
    const ageMs = now - new Date(row.created_at).getTime()
    const hasOutput = !!row.assistant_output?.trim()
    const stale = ageMs > 15 * 60 * 1000 || (!hasOutput && ageMs > 2 * 60 * 1000)
    if (!stale) continue
    await finishOpencodeRequest({
      id: row.id,
      status: 'failed',
      assistantOutput: row.assistant_output,
      opencodeSessionId: row.opencode_session_id,
      error: 'stale_run',
    })
  }
}

function buildDateFilters(opts: {
  startAt?: Date | null;
  endAt?: Date | null;
  sinceAt?: Date | null;
}) {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.startAt) {
    clauses.push("datetime(created_at) >= datetime(?)");
    params.push(opts.startAt.toISOString());
  }
  if (opts.endAt) {
    clauses.push("datetime(created_at) <= datetime(?)");
    params.push(opts.endAt.toISOString());
  }
  if (!opts.startAt && !opts.endAt && opts.sinceAt) {
    clauses.push("datetime(created_at) >= datetime(?)");
    params.push(opts.sinceAt.toISOString());
  }
  return { clauses, params };
}

export async function listOpencodeRequestsForAdmin(opts: {
  tokenId?: string;
  status?: string;
  startAt?: Date | null;
  endAt?: Date | null;
  sinceAt?: Date | null;
  limit: number;
}): Promise<OpencodeRequestAdminRow[]> {
  await ensureOpencodeRequestTable();
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (opts.tokenId) {
    where.push("api_token_id = ?");
    params.push(opts.tokenId);
  } else {
    where.push("api_token_id IS NOT NULL");
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const dateFilters = buildDateFilters(opts);
  where.push(...dateFilters.clauses);
  params.push(...dateFilters.params);
  params.push(opts.limit);

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, api_token_id, chat_session_id, opencode_session_id, app_scope_id, module, class_fqn,
            user_prompt, assistant_output, model_name, status, error, created_at, finished_at
     FROM opencode_requests
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
    ...params,
  );

  const tokenIds = [...new Set(rows.map((r) => r.api_token_id))];
  const tokens = tokenIds.length
    ? await prisma.apiToken.findMany({
        where: { id: { in: tokenIds } },
        select: { id: true, personName: true, personCode: true, label: true },
      })
    : [];
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  return rows.map((row) => ({
    ...mapRow(row),
    token: tokenMap.get(row.api_token_id) || null,
  }));
}

export async function aggregateOpencodeUsage(opts: {
  tokenId?: string;
  startAt?: Date | null;
  endAt?: Date | null;
  sinceAt?: Date | null;
}): Promise<Array<{ apiTokenId: string; status: string; createdAt: string }>> {
  await ensureOpencodeRequestTable();
  const where: string[] = ["api_token_id IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.tokenId) {
    where.push("api_token_id = ?");
    params.push(opts.tokenId);
  }
  const dateFilters = buildDateFilters(opts);
  where.push(...dateFilters.clauses);
  params.push(...dateFilters.params);

  return prisma.$queryRawUnsafe<Array<{ api_token_id: string; status: string; created_at: string }>>(
    `SELECT api_token_id, status, created_at
     FROM opencode_requests
     WHERE ${where.join(" AND ")}`,
    ...params,
  ).then((rows) =>
    rows.map((row) => ({
      apiTokenId: row.api_token_id,
      status: row.status,
      createdAt: row.created_at,
    })),
  );
}

export async function countOpencodeRequestsByStatus(options?: {
  startAt?: Date | null;
  endAt?: Date | null;
}): Promise<{
  total: number;
  done: number;
  failed: number;
  running: number;
}> {
  await ensureOpencodeRequestTable();
  const params: string[] = [];
  let where = "WHERE api_token_id IS NOT NULL";
  if (options?.startAt) {
    where += " AND datetime(created_at) >= datetime(?)";
    params.push(options.startAt.toISOString());
  }
  if (options?.endAt) {
    where += " AND datetime(created_at) <= datetime(?)";
    params.push(options.endAt.toISOString());
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string; count: number }>>(
    `SELECT status, COUNT(*) as count FROM opencode_requests ${where} GROUP BY status`,
    ...params,
  );
  const counts = { total: 0, done: 0, failed: 0, running: 0 };
  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;
    if (row.status === "done") counts.done += n;
    else if (row.status === "failed") counts.failed += n;
    else if (row.status === "running") counts.running += n;
  }
  return counts;
}

export async function listOpencodeRequestsInWindow(
  startAt: Date | null,
  endAt: Date,
): Promise<
  Array<{
    createdAt: string;
    apiTokenId: string;
    personName: string | null;
    personCode: string | null;
  }>
> {
  await ensureOpencodeRequestTable();
  const params: string[] = [];
  let where = "WHERE api_token_id IS NOT NULL";
  if (startAt) {
    where += " AND datetime(created_at) >= datetime(?)";
    params.push(startAt.toISOString());
  }
  where += " AND datetime(created_at) <= datetime(?)";
  params.push(endAt.toISOString());
  const rows = await prisma.$queryRawUnsafe<Array<{ created_at: string; api_token_id: string }>>(
    `SELECT created_at, api_token_id
     FROM opencode_requests
     ${where}
     ORDER BY created_at ASC`,
    ...params,
  );
  const tokenIds = [...new Set(rows.map((row) => row.api_token_id))];
  const tokens = tokenIds.length
    ? await prisma.apiToken.findMany({
        where: { id: { in: tokenIds } },
        select: { id: true, personName: true, personCode: true },
      })
    : [];
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  return rows.map((row) => ({
    createdAt: row.created_at,
    apiTokenId: row.api_token_id,
    personName: tokenMap.get(row.api_token_id)?.personName ?? null,
    personCode: tokenMap.get(row.api_token_id)?.personCode ?? null,
  }));
}

/** @deprecated use listOpencodeRequestsInWindow */
export async function listOpencodeRequestsSince(startAt: Date) {
  return listOpencodeRequestsInWindow(startAt, new Date());
}

function parseChatMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function parseDbDateMs(raw: string | Date) {
  if (raw instanceof Date) return raw.getTime();
  const value = String(raw || "").trim();
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized).getTime();
}

type ChatSessionMessage = {
  role: string;
  content: string;
  createdAt: number;
  metadata: Record<string, unknown> | null;
};

function resolveImagesFromChatAssistant(
  messages: ChatSessionMessage[],
  userPrompt: string,
  anchorAt: number,
): OpencodeImageRef[] {
  const prompt = userPrompt.trim();
  if (!prompt) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const assistant = messages[i];
    if (assistant.role !== "assistant") continue;
    if (Math.abs(assistant.createdAt - anchorAt) > 10 * 60 * 1000) continue;
    let matchedUser: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j].role === "user") {
        matchedUser = messages[j].content;
        break;
      }
    }
    if (matchedUser?.trim() !== prompt) continue;
    return collectOpencodeImages({
      metadata: assistant.metadata,
      content: assistant.content,
    });
  }
  return [];
}

function resolveAttachmentsFromChatUser(
  messages: ChatSessionMessage[],
  userPrompt: string,
  anchorAt: number,
): ChatAttachment[] {
  const prompt = userPrompt.trim();
  if (!prompt) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (Math.abs(msg.createdAt - anchorAt) > 10 * 60 * 1000) continue;
    if (msg.content.trim() !== prompt) continue;
    return normalizeChatAttachments(msg.metadata?.attachments);
  }
  return [];
}

/** 为 opencode 审计行补齐 chat_messages.metadata.images（图片常只存 metadata，不在 assistant_output 文本里） */
export async function attachChatOutputImagesToOpencodeRows(
  rows: OpencodeRequestAdminRow[],
): Promise<OpencodeRequestAdminRow[]> {
  if (!rows.length) return rows;

  const sessionIds = [...new Set(rows.map((row) => row.chatSessionId).filter(Boolean))] as string[];
  const bySession = new Map<string, ChatSessionMessage[]>();

  if (sessionIds.length) {
    try {
      const placeholders = sessionIds.map(() => "?").join(", ");
      const sessionMessages = await prisma.$queryRawUnsafe<
        Array<{ session_id: string; role: string; content: string; created_at: string; metadata: string | null }>
      >(
        `SELECT session_id, role, content, created_at, metadata
         FROM chat_messages
         WHERE session_id IN (${placeholders})
         ORDER BY created_at ASC`,
        ...sessionIds,
      );
      for (const msg of sessionMessages) {
        const list = bySession.get(msg.session_id) || [];
        list.push({
          role: msg.role,
          content: msg.content,
          createdAt: parseDbDateMs(msg.created_at),
          metadata: parseChatMetadata(msg.metadata),
        });
        bySession.set(msg.session_id, list);
      }
    } catch {
      // chat_messages 不存在时仅回退文本解析
    }
  }

  return rows.map((row) => {
    const anchorAt = row.finishedAt ? new Date(row.finishedAt).getTime() : new Date(row.createdAt).getTime();
    const messages = row.chatSessionId ? bySession.get(row.chatSessionId) || [] : [];
    const fromChat =
      row.chatSessionId && row.userPrompt
        ? resolveImagesFromChatAssistant(messages, row.userPrompt, anchorAt)
        : [];
    const userAttachments =
      row.chatSessionId && row.userPrompt
        ? resolveAttachmentsFromChatUser(messages, row.userPrompt, anchorAt)
        : [];
    const outputImages = collectOpencodeImages({
      content: row.assistantOutput,
      extra: fromChat,
    });
    return {
      ...row,
      ...(row.outputImages?.length ? {} : outputImages.length ? { outputImages } : {}),
      ...(row.userAttachments?.length ? {} : userAttachments.length ? { userAttachments } : {}),
    };
  });
}

/** 审计表上线前，OpenCode 仅写入 chat_messages，此处做兼容回显 */
export async function listLegacyOpencodeFromChatForAdmin(opts: {
  tokenId?: string;
  status?: string;
  startAt?: Date | null;
  endAt?: Date | null;
  sinceAt?: Date | null;
  limit: number;
  excludeKeys?: Set<string>;
}): Promise<OpencodeRequestAdminRow[]> {
  if (opts.status && opts.status !== "done") return [];

  const where: string[] = [
    "m.role = 'assistant'",
    "m.metadata LIKE '%\"backend\":\"opencode\"%'",
    "s.token_id IS NOT NULL",
  ];
  const params: unknown[] = [];
  if (opts.tokenId) {
    where.push("s.token_id = ?");
    params.push(opts.tokenId);
  }
  const dateFilters = buildDateFilters(opts);
  where.push(...dateFilters.clauses.map((c) => c.replace(/created_at/g, "m.created_at")));
  params.push(...dateFilters.params);
  params.push(Math.max(opts.limit, 50));

  try {
    const assistantRows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        session_id: string;
        content: string;
        metadata: string | null;
        created_at: string;
        token_id: string;
      }>
    >(
      `SELECT m.id, m.session_id, m.content, m.metadata, m.created_at, s.token_id
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`,
      ...params,
    );

    if (!assistantRows.length) return [];

    const sessionIds = [...new Set(assistantRows.map((r) => r.session_id))];
    const placeholders = sessionIds.map(() => "?").join(", ");
    const sessionMessages = await prisma.$queryRawUnsafe<
      Array<{ session_id: string; role: string; content: string; created_at: string; metadata: string | null }>
    >(
      `SELECT session_id, role, content, created_at, metadata
       FROM chat_messages
       WHERE session_id IN (${placeholders})
       ORDER BY created_at ASC`,
      ...sessionIds,
    );

    const bySession = new Map<
      string,
      Array<{ role: string; content: string; createdAt: number; metadata: Record<string, unknown> | null }>
    >();
    for (const msg of sessionMessages) {
      const list = bySession.get(msg.session_id) || [];
      list.push({
        role: msg.role,
        content: msg.content,
        createdAt: parseDbDateMs(msg.created_at),
        metadata: parseChatMetadata(msg.metadata),
      });
      bySession.set(msg.session_id, list);
    }

    const tokenIds = [...new Set(assistantRows.map((r) => r.token_id))];
    const tokens = await prisma.apiToken.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, personName: true, personCode: true, label: true },
    });
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));

    const rows: OpencodeRequestAdminRow[] = [];
    for (const assistant of assistantRows) {
      const meta = parseChatMetadata(assistant.metadata);
      const appScopeId = typeof meta?.appScopeId === "string" ? meta.appScopeId : null;
      const list = bySession.get(assistant.session_id) || [];
      const assistantAt = parseDbDateMs(assistant.created_at);
      let userPrompt: string | null = null;
      let userAttachments: ChatAttachment[] = [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const msg = list[i];
        if (msg.createdAt > assistantAt) continue;
        if (msg.role === "user") {
          userPrompt = msg.content;
          userAttachments = normalizeChatAttachments(msg.metadata?.attachments);
          break;
        }
      }
      if (!userPrompt) continue;

      const dedupeKey = `${assistant.session_id}:${userPrompt.trim()}`;
      if (opts.excludeKeys?.has(dedupeKey)) continue;

      const scopes = listAndroidAppScopes();
      const module =
        appScopeId && appScopeId !== "all"
          ? scopes.find((s) => s.id === appScopeId)?.label || appScopeId
          : "全部应用";

      rows.push({
        id: `legacy-chat-${assistant.id}`,
        apiTokenId: assistant.token_id,
        chatSessionId: assistant.session_id,
        opencodeSessionId:
          typeof meta?.opencodeSessionId === "string" ? meta.opencodeSessionId : null,
        appScopeId,
        module,
        classFqn: extractClassHintFromPrompt(userPrompt),
        userPrompt,
        modelName: null,
        assistantOutput: assistant.content,
        outputImages: collectOpencodeImages({ metadata: meta, content: assistant.content }),
        userAttachments,
        status: "done",
        error: null,
        createdAt: assistant.created_at,
        finishedAt: assistant.created_at,
        token: tokenMap.get(assistant.token_id) || null,
      });
    }

    return rows.slice(0, opts.limit);
  } catch {
    return [];
  }
}
