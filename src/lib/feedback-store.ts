import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type FeedbackRow = {
  id: string;
  content: string;
  userAgent: string | null;
  createdAt: string | Date;
  apiTokenId: string | null;
  personName: string | null;
  personCode: string | null;
  label: string | null;
};

export async function ensureFeedbackTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      user_agent TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      api_token_id TEXT,
      FOREIGN KEY (api_token_id) REFERENCES ApiToken(id) ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS user_feedback_created_at_idx ON user_feedback(created_at)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS user_feedback_api_token_id_idx ON user_feedback(api_token_id)`);
}

export async function createFeedback(params: { content: string; apiTokenId: string; userAgent: string | null }) {
  await ensureFeedbackTable();
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_feedback (id, content, user_agent, api_token_id) VALUES (?, ?, ?, ?)`,
    id,
    params.content,
    params.userAgent,
    params.apiTokenId
  );
  return { id };
}

export async function listFeedback(limit: number): Promise<FeedbackRow[]> {
  await ensureFeedbackTable();
  return prisma.$queryRawUnsafe<FeedbackRow[]>(
    `SELECT
       f.id,
       f.content,
       f.user_agent AS userAgent,
       f.created_at AS createdAt,
       f.api_token_id AS apiTokenId,
       t.personName AS personName,
       t.personCode AS personCode,
       t.label AS label
     FROM user_feedback f
     LEFT JOIN ApiToken t ON t.id = f.api_token_id
     ORDER BY f.created_at DESC
     LIMIT ?`,
    limit
  );
}
