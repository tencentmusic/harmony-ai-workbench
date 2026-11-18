import crypto from "crypto";
import { prisma } from "@/lib/prisma";

/** 表结构以 prisma/schema.prisma → ChatSession / ChatMessage 为准；ensure 仅兜底。 */

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessage[];
  hasMore: boolean;
};

let initialized = false;

async function ensureChatTables() {
  if (initialized) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_token_updated ON chat_sessions(token_id, updated_at DESC);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at ASC);`);
  initialized = true;
}

type SessionRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
};

function parseMetadata(v: string | null): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const obj = JSON.parse(v) as Record<string, unknown>;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

export async function listSessionsByToken(tokenId: string): Promise<ChatSession[]> {
  await ensureChatTables();
  const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, title, created_at, updated_at FROM chat_sessions WHERE token_id = ? ORDER BY updated_at DESC`,
    tokenId
  );
  return rows.map((x) => ({
    id: x.id,
    title: x.title,
    createdAt: x.created_at,
    updatedAt: x.updated_at,
  }));
}

export async function createSession(tokenId: string, title: string): Promise<ChatSession> {
  await ensureChatTables();
  const id = crypto.randomUUID();
  const safeTitle = title.trim() || "新会话";
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_sessions (id, token_id, title) VALUES (?, ?, ?)`,
    id,
    tokenId,
    safeTitle.slice(0, 80)
  );
  const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? LIMIT 1`,
    id
  );
  const row = rows[0];
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSessionByIdForToken(sessionId: string, tokenId: string): Promise<ChatSession | null> {
  await ensureChatTables();
  const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND token_id = ? LIMIT 1`,
    sessionId,
    tokenId
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function deleteSessionForToken(sessionId: string, tokenId: string): Promise<boolean> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(sessionId, tokenId);
  if (!session) return false;
  await prisma.$executeRawUnsafe(`DELETE FROM chat_messages WHERE session_id = ?`, sessionId);
  await prisma.$executeRawUnsafe(`DELETE FROM chat_sessions WHERE id = ? AND token_id = ?`, sessionId, tokenId);
  return true;
}

export async function renameSessionForToken(sessionId: string, tokenId: string, title: string): Promise<ChatSession | null> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(sessionId, tokenId);
  if (!session) return null;
  const safeTitle = title.trim().slice(0, 80) || "新会话";
  await prisma.$executeRawUnsafe(
    `UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND token_id = ?`,
    safeTitle,
    sessionId,
    tokenId
  );
  return getSessionByIdForToken(sessionId, tokenId);
}

export async function listMessagesBySessionForToken(sessionId: string, tokenId: string): Promise<ChatMessage[] | null> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(sessionId, tokenId);
  if (!session) return null;
  const rows = await prisma.$queryRawUnsafe<MessageRow[]>(
    `SELECT id, session_id, role, content, metadata, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC`,
    sessionId
  );
  return rows.map((x) => ({
    id: x.id,
    sessionId: x.session_id,
    role: x.role === "assistant" ? "assistant" : "user",
    content: x.content,
    metadata: parseMetadata(x.metadata),
    createdAt: x.created_at,
  }));
}

export async function listMessagesBySessionForTokenPaged(opts: {
  sessionId: string;
  tokenId: string;
  beforeCreatedAt?: string;
  beforeId?: string;
  limit?: number;
}): Promise<ChatMessagePage | null> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(opts.sessionId, opts.tokenId);
  if (!session) return null;
  const limit = Math.max(1, Math.min(100, opts.limit || 30));
  const beforeCreatedAt = opts.beforeCreatedAt?.trim() || "";
  const beforeId = opts.beforeId?.trim() || "";
  const rows = await prisma.$queryRawUnsafe<MessageRow[]>(
    `
      SELECT id, session_id, role, content, metadata, created_at
      FROM chat_messages
      WHERE session_id = ?
        AND (
          ? = ''
          OR created_at < ?
          OR (created_at = ? AND id < ?)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    opts.sessionId,
    beforeCreatedAt,
    beforeCreatedAt,
    beforeCreatedAt,
    beforeId,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const sliced = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return {
    hasMore,
    items: sliced.map((x) => ({
      id: x.id,
      sessionId: x.session_id,
      role: x.role === "assistant" ? "assistant" : "user",
      content: x.content,
      metadata: parseMetadata(x.metadata),
      createdAt: x.created_at,
    })),
  };
}

export async function listRecentMessagesBySessionForToken(opts: {
  sessionId: string;
  tokenId: string;
  limit?: number;
}): Promise<ChatMessage[] | null> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(opts.sessionId, opts.tokenId);
  if (!session) return null;
  const limit = Math.max(1, Math.min(50, opts.limit || 12));
  const rows = await prisma.$queryRawUnsafe<MessageRow[]>(
    `
      SELECT id, session_id, role, content, metadata, created_at
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    opts.sessionId,
    limit
  );
  return rows.reverse().map((x) => ({
    id: x.id,
    sessionId: x.session_id,
    role: x.role === "assistant" ? "assistant" : "user",
    content: x.content,
    metadata: parseMetadata(x.metadata),
    createdAt: x.created_at,
  }));
}

export async function patchChatMessageMetadataForToken(opts: {
  messageId: string;
  sessionId: string;
  tokenId: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(opts.sessionId, opts.tokenId);
  if (!session) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM chat_messages WHERE id = ? AND session_id = ? LIMIT 1`,
    opts.messageId,
    opts.sessionId,
  );
  if (!rows[0]?.id) return false;
  await prisma.$executeRawUnsafe(
    `UPDATE chat_messages SET metadata = ? WHERE id = ?`,
    JSON.stringify(opts.metadata),
    opts.messageId,
  );
  return true;
}

export async function appendMessageToSessionForToken(opts: {
  sessionId: string;
  tokenId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown> | null;
}): Promise<ChatMessage | null> {
  await ensureChatTables();
  const session = await getSessionByIdForToken(opts.sessionId, opts.tokenId);
  if (!session) return null;
  const id = crypto.randomUUID();
  const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)`,
    id,
    opts.sessionId,
    opts.role,
    opts.content,
    metadataJson
  );
  await prisma.$executeRawUnsafe(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, opts.sessionId);
  const rows = await prisma.$queryRawUnsafe<MessageRow[]>(
    `SELECT id, session_id, role, content, metadata, created_at FROM chat_messages WHERE id = ? LIMIT 1`,
    id
  );
  const row = rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}
