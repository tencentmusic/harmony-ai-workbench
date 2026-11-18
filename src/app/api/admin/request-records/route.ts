import {
  buildAgentModelDisplay,
  resolveAgentModelLabel,
} from "@/lib/agent-backend";
import { normalizeChatAttachments, type ChatAttachment } from "@/lib/chat-attachments-shared";
import { attachChatOutputImagesToOpencodeRows, listLegacyOpencodeFromChatForAdmin, listOpencodeRequestsForAdmin } from "@/lib/opencode-request-store";
import { collectOpencodeImages } from "@/lib/opencode/opencode-image";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

function readJobId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { jobId?: unknown };
    return typeof parsed.jobId === "string" ? parsed.jobId : null;
  } catch {
    return null;
  }
}

function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
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

function readDateParam(value: string | null): Date | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t) : null;
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();
  const url = new URL(req.url);
  const tokenId = (url.searchParams.get("tokenId") || "").trim();
  const status = (url.searchParams.get("status") || "").trim().toLowerCase();
  const allowedStatuses = new Set(["pending", "running", "done", "failed", "canceled"]);
  if (status && !allowedStatuses.has(status)) {
    return Response.json({ error: "status_invalid" }, { status: 400 });
  }
  const startAt = readDateParam(url.searchParams.get("startAt"));
  const endAt = readDateParam(url.searchParams.get("endAt"));
  const sinceDaysRaw = Number(url.searchParams.get("sinceDays") || 0);
  const sinceDays = Number.isFinite(sinceDaysRaw) ? Math.max(0, Math.min(365, Math.floor(sinceDaysRaw))) : 0;
  const sinceAt = !startAt && sinceDays > 0 ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000) : null;
  const limitRaw = Number(url.searchParams.get("limit") || 120);
  const limit = Math.max(1, Math.min(300, Number.isFinite(limitRaw) ? limitRaw : 120));
  const createdAtFilter = startAt || endAt ? { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lte: endAt } : {}) } : sinceAt ? { gte: sinceAt } : undefined;
  const where = tokenId
    ? { apiTokenId: tokenId, ...(status ? { status } : {}), ...(createdAtFilter ? { createdAt: createdAtFilter } : {}) }
    : { apiTokenId: { not: null }, ...(status ? { status } : {}), ...(createdAtFilter ? { createdAt: createdAtFilter } : {}) };

  const [jobs, opencodeRows, opencodeModelFallback] = await Promise.all([
    prisma.conversionJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        module: true,
        classFqn: true,
        modelId: true,
        output: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        outputPurgedAt: true,
        apiTokenId: true,
        apiToken: {
          select: {
            id: true,
            personName: true,
            personCode: true,
            label: true,
          },
        },
      },
    }),
    listOpencodeRequestsForAdmin({
      tokenId: tokenId || undefined,
      status: status || undefined,
      startAt,
      endAt,
      sinceAt,
      limit,
    }),
    resolveAgentModelLabel(),
  ]);

  const auditedKeys = new Set(
    opencodeRows
      .filter((row) => row.chatSessionId && row.userPrompt)
      .map((row) => `${row.chatSessionId}:${row.userPrompt.trim()}`),
  );
  const legacyOpencodeRows = await listLegacyOpencodeFromChatForAdmin({
    tokenId: tokenId || undefined,
    status: status || undefined,
    startAt,
    endAt,
    sinceAt,
    limit,
    excludeKeys: auditedKeys,
  });
  const allOpencodeRows = await attachChatOutputImagesToOpencodeRows([...opencodeRows, ...legacyOpencodeRows]);

  const modelIds = [...new Set(jobs.map((j) => j.modelId))];
  const models = modelIds.length
    ? await prisma.modelConfig.findMany({
        where: { id: { in: modelIds } },
        select: { id: true, displayName: true, model: true },
      })
    : [];
  const modelMap = new Map(models.map((m) => [m.id, m]));
  const chatDetailsMap = new Map<string, { userInput: string | null; userAttachments: ChatAttachment[]; assistantOutput: string | null }>();

  if (jobs.length) {
    try {
      const likeClauses = jobs.map(() => "metadata LIKE ?").join(" OR ");
      const likeParams = jobs.map((j) => `%"jobId":"${j.id}"%`);

      const assistantRows = await prisma.$queryRawUnsafe<Array<{ session_id: string; content: string; metadata: string | null; created_at: string | Date }>>(
        `SELECT session_id, content, metadata, created_at
         FROM chat_messages
         WHERE role = 'assistant' AND (${likeClauses})`,
        ...likeParams,
      );

      const assistantByJob = new Map<string, { sessionId: string; content: string; createdAt: number }>();
      for (const row of assistantRows) {
        const jobId = readJobId(row.metadata);
        if (!jobId) continue;
        const createdAt = parseDbDateMs(row.created_at);
        const prev = assistantByJob.get(jobId);
        if (!prev || prev.createdAt < createdAt) {
          assistantByJob.set(jobId, { sessionId: row.session_id, content: row.content, createdAt });
        }
      }

      const sessionIds = [...new Set([...assistantByJob.values()].map((x) => x.sessionId))];
      if (sessionIds.length) {
        const sessionPlaceholders = sessionIds.map(() => "?").join(", ");
        const sessionMessages = await prisma.$queryRawUnsafe<Array<{ session_id: string; role: string; content: string; metadata: string | null; created_at: string | Date }>>(
          `SELECT session_id, role, content, metadata, created_at
           FROM chat_messages
           WHERE session_id IN (${sessionPlaceholders})
           ORDER BY created_at ASC`,
          ...sessionIds,
        );

        const bySession = new Map<string, Array<{ role: string; content: string; createdAt: number; metadata: Record<string, unknown> | null }>>();
        for (const msg of sessionMessages) {
          const list = bySession.get(msg.session_id) || [];
          list.push({ role: msg.role, content: msg.content, createdAt: parseDbDateMs(msg.created_at), metadata: parseMetadata(msg.metadata) });
          bySession.set(msg.session_id, list);
        }

        for (const [jobId, assistant] of assistantByJob) {
          const list = bySession.get(assistant.sessionId) || [];
          let userInput: string | null = null;
          let userAttachments: ChatAttachment[] = [];
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const msg = list[i];
            if (msg.createdAt > assistant.createdAt) continue;
            if (msg.role === "user") {
              userInput = msg.content;
              userAttachments = normalizeChatAttachments(msg.metadata?.attachments);
              break;
            }
          }
          chatDetailsMap.set(jobId, { userInput, userAttachments, assistantOutput: assistant.content });
        }
      }
    } catch {
      // chat_messages table may not exist in environments that never used chat; keep response compatible.
    }
  }

  const convertItems = jobs.map((j) => {
    const m = modelMap.get(j.modelId);
    const durationMs = j.finishedAt ? Math.max(0, j.finishedAt.getTime() - j.createdAt.getTime()) : null;
    const detail = chatDetailsMap.get(j.id);
    return {
      id: j.id,
      mode: "convert" as const,
      status: j.status,
      module: j.module,
      classFqn: j.classFqn,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      durationMs,
      model: {
        id: j.modelId,
        displayName: m?.displayName || null,
        model: m?.model || null,
      },
      token: j.apiToken
        ? {
            id: j.apiToken.id,
            personName: j.apiToken.personName,
            personCode: j.apiToken.personCode,
            label: j.apiToken.label,
          }
        : null,
      errorPreview: j.error ? j.error.slice(0, 180) : null,
      userInput: detail?.userInput || null,
      userAttachments: detail?.userAttachments || [],
      modelOutput: j.output || detail?.assistantOutput || null,
      outputImages: collectOpencodeImages({ content: j.output || detail?.assistantOutput || null }),
      outputPurgedAt: j.outputPurgedAt,
    };
  });

  const opencodeItems = allOpencodeRows.map((row) => {
    const createdAt = new Date(row.createdAt);
    const finishedAt = row.finishedAt ? new Date(row.finishedAt) : null;
    const durationMs = finishedAt ? Math.max(0, finishedAt.getTime() - createdAt.getTime()) : null;
    return {
      id: row.id,
      mode: "opencode" as const,
      status: row.status,
      module: row.module,
      classFqn: row.classFqn,
      createdAt,
      finishedAt,
      durationMs,
      model: buildAgentModelDisplay(row.modelName || opencodeModelFallback),
      token: row.token
        ? {
            id: row.token.id,
            personName: row.token.personName,
            personCode: row.token.personCode,
            label: row.token.label,
          }
        : null,
      errorPreview: row.error ? row.error.slice(0, 180) : null,
      userInput: row.userPrompt,
      userAttachments: row.userAttachments || [],
      modelOutput: row.assistantOutput,
      outputImages: row.outputImages?.length ? row.outputImages : collectOpencodeImages({ content: row.assistantOutput }),
      outputPurgedAt: null,
    };
  });

  const items = [...convertItems, ...opencodeItems]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return Response.json({ items });
}
