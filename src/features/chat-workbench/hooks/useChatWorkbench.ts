"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AndroidAppScope, AndroidClassCandidate, ChatAttachment, ChatMessage, ChatSession, OpencodeImageAttachment, ViewerProfile } from "../types";
import { CHAT_ATTACHMENT_MAX_COUNT, CHAT_ATTACHMENT_MAX_SIZE } from "@/lib/chat-attachments-shared";
import { dedupeOpencodeImages, extractOpencodeImagesFromText } from "@/lib/opencode/opencode-image";
import { randomId } from "@/lib/random-id";
import { buildSessionTitleFromPrompt, shouldAutoRenameSession } from "@/lib/session-title";
import type { KnowledgeLocator } from "@/contracts/knowledge";

type RequestError = { error?: string };
type PageCursor = { beforeCreatedAt: string; beforeId: string };
type SessionStreamState = {
  partial: string;
  reasoning: string;
  images: OpencodeImageAttachment[];
  status: "pending" | "running";
  abort: AbortController;
};

function isAbortLikeError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const msg = error instanceof Error ? error.message : String(error || "");
  const normalized = msg.toLowerCase();
  return normalized.includes("abort") || normalized.includes("canceled") || normalized.includes("cancelled");
}

function formatChatErrorMessage(raw: string) {
  const msg = String(raw || "").trim();
  if (!msg) return "请求失败，请稍后重试";
  if (/ImagePhotonUnavailableError|Photon image processor is unavailable/i.test(msg)) {
    return "测试服 OpenCode 暂未启用图片处理能力，图片附件当前无法分析";
  }
  if (/fetch failed|ECONNRESET|socket hang up/i.test(msg)) {
    return "Agent 服务异常中断（可能内存不足），请稍后重试";
  }
  if (/opencode_response_timeout/i.test(msg)) {
    return "本次回答超过时限，已停止后台任务；已生成内容可能不完整，可继续生成";
  }
  if (/opencode_upstream_stream_interrupted|opencode_stream_interrupted|stream_read_error|upstream_error/i.test(msg)) {
    return "模型连接中途断开；已保留生成内容，可继续生成";
  }
  if (msg === "chat_session_busy") {
    return "当前对话仍在分析中，请等待完成或点击停止后再发送";
  }
  if (msg === "attachment_too_large") {
    return `单个附件不能超过 ${Math.round(CHAT_ATTACHMENT_MAX_SIZE / (1024 * 1024))}MB`;
  }
  if (msg === "too_many_attachments") {
    return `最多支持 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件`;
  }
  return msg;
}

function getActiveMention(text: string) {
  const m = text.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const keyword = m[1] || "";
  return { keyword, tokenText: `@${keyword}` };
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveLatestAgentSessionId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const sid = typeof msg.metadata?.opencodeSessionId === "string" ? msg.metadata.opencodeSessionId.trim() : "";
    // OpenCode session ids are ses_*; server-side parseAgentSessionId rejects non-matching ids per backend.
    if (sid) return sid;
  }
  return null;
}

function parseClassExplainDeepLink() {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search || "");
  const intent = String(sp.get("intent") || "").trim().toLowerCase();
  const classFqn = String(sp.get("classFqn") || "").trim();
  const autoSend = String(sp.get("autoSend") || "").trim() === "1";
  if (intent !== "class-explain") return null;
  if (!/^(?:[A-Za-z_][A-Za-z0-9_$]*\.){2,}[A-Za-z_][A-Za-z0-9_$]*$/.test(classFqn)) return null;
  const prompt = `请分析 @${classFqn} 的业务逻辑、调用链、关键依赖与迁移注意点。`;
  const key = `${intent}:${classFqn}:${String(sp.get("docPath") || "")}`;
  return { key, prompt, autoSend };
}

function revokeAttachmentPreviews(items: ChatAttachment[]) {
  for (const item of items) {
    if (item.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function resolveOpencodeSessionForChat(chatSessionId: string, cache: Record<string, string>, messages: ChatMessage[]) {
  const cached = cache[chatSessionId]?.trim();
  if (cached) return cached;
  const fromHistory = resolveLatestAgentSessionId(messages);
  if (fromHistory) cache[chatSessionId] = fromHistory;
  return fromHistory;
}

export function useChatWorkbench(router: AppRouterInstance) {
  const [appScopes, setAppScopes] = useState<AndroidAppScope[]>([]);
  const [appScopeId, setAppScopeId] = useState("all");
  const [selectedClasses, setSelectedClasses] = useState<AndroidClassCandidate[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [knowledgeLocator, setKnowledgeLocator] = useState<KnowledgeLocator | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [streamUiTick, setStreamUiTick] = useState(0);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [err, setErr] = useState("");
  const [viewer, setViewer] = useState<ViewerProfile | null>(null);
  const [classCandidates, setClassCandidates] = useState<AndroidClassCandidate[]>([]);
  const [classSearching, setClassSearching] = useState(false);
  const [forceStickBottomTick, setForceStickBottomTick] = useState(0);
  const [canceling, setCanceling] = useState(false);
  const oldestCursorRef = useRef<PageCursor | null>(null);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const sessionStreamsRef = useRef<Record<string, SessionStreamState>>({});
  const activeSessionIdRef = useRef("");
  const cancelRequestedRef = useRef(false);
  const opencodeSessionByChatRef = useRef<Record<string, string>>({});
  const messagesRef = useRef<ChatMessage[]>([]);
  const inputTextRef = useRef("");
  const knowledgeLocatorRef = useRef<KnowledgeLocator | null>(null);
  const activeReplyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeReplyPollCountRef = useRef(0);
  const activeReplyPollSessionRef = useRef("");
  const loadMessagesSeqRef = useRef<Record<string, number>>({});
  const recoverActiveReplyRef = useRef<(sessionId: string) => Promise<void>>(async () => {});
  const activeMention = useMemo(() => getActiveMention(inputText), [inputText]);
  const deepLinkRef = useRef<null | { key: string; prompt: string; autoSend: boolean }>(null);
  const deepLinkHydratedRef = useRef(false);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => revokeAttachmentPreviews(attachmentsRef.current);
  }, []);

  const bumpStreamUi = useCallback(() => setStreamUiTick((n) => n + 1), []);

  const beginSessionStream = useCallback(
    (sessionId: string) => {
      const abort = new AbortController();
      sessionStreamsRef.current[sessionId] = { partial: "", reasoning: "", images: [], status: "pending", abort };
      bumpStreamUi();
      return abort;
    },
    [bumpStreamUi]
  );

  const updateSessionStream = useCallback(
    (sessionId: string, patch: { partial?: string; reasoning?: string; images?: OpencodeImageAttachment[]; status?: "pending" | "running" }) => {
      const row = sessionStreamsRef.current[sessionId];
      if (!row) return;
      if (patch.partial !== undefined) row.partial = patch.partial;
      if (patch.reasoning !== undefined) row.reasoning = patch.reasoning;
      if (patch.images !== undefined) row.images = patch.images;
      if (patch.status !== undefined) row.status = patch.status;
      if (activeSessionIdRef.current === sessionId) bumpStreamUi();
    },
    [bumpStreamUi]
  );

  const endSessionStream = useCallback(
    (sessionId: string) => {
      if (!sessionStreamsRef.current[sessionId]) return;
      delete sessionStreamsRef.current[sessionId];
      if (activeSessionIdRef.current === sessionId) bumpStreamUi();
    },
    [bumpStreamUi]
  );

  const isSessionStreaming = useCallback((sessionId: string) => {
    return !!sessionId && !!sessionStreamsRef.current[sessionId];
  }, []);

  useEffect(() => {
    if (!err) return;
    const timer = setTimeout(() => setErr(""), 3000);
    return () => clearTimeout(timer);
  }, [err]);

  useEffect(() => {
    if (deepLinkHydratedRef.current) return;
    deepLinkHydratedRef.current = true;
    const parsed = parseClassExplainDeepLink();
    if (!parsed) return;
    deepLinkRef.current = parsed;
    setSelectedClasses([]);
    setClassCandidates([]);
    setInputText(parsed.prompt);
  }, []);

  const authHeader = useCallback(() => ({ Authorization: `Bearer ${localStorage.getItem("hm_token") || ""}` }), []);

  const requestJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & RequestError;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, []);

  const loadSessions = useCallback(async (options?: { silent?: boolean }) => {
    const silent = !!options?.silent;
    if (!silent) setLoadingSessions(true);
    try {
      const data = await requestJson<{ items: ChatSession[] }>("/api/chat/sessions", { headers: { ...authHeader() } });
      setSessions(data.items || []);
      if (data.items?.[0]) {
        setActiveSessionId((prev) => prev || data.items[0].id);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoadingSessions(false);
    }
  }, [authHeader, requestJson]);

  const loadMessages = useCallback(
    async (sessionId: string, options?: { silent?: boolean }) => {
      if (!sessionId) {
        setMessages([]);
        setHasMoreMessages(false);
        oldestCursorRef.current = null;
        return;
      }
      const seq = (loadMessagesSeqRef.current[sessionId] ?? 0) + 1;
      loadMessagesSeqRef.current[sessionId] = seq;
      const silent = !!options?.silent;
      if (!silent) setLoadingMessages(true);
      try {
        const data = await requestJson<{ items: ChatMessage[]; pageInfo?: { hasMore?: boolean } }>(
          `/api/chat/sessions/${sessionId}/messages?limit=30`,
          { headers: { ...authHeader() } }
        );
        if (loadMessagesSeqRef.current[sessionId] !== seq) return;
        const list = data.items || [];
        const agentSessionId = resolveLatestAgentSessionId(list);
        if (agentSessionId) {
          opencodeSessionByChatRef.current[sessionId] = agentSessionId;
        }
        // Keep in-memory ses_* when metadata is not yet persisted; do not wipe after each reply.
        if (activeSessionIdRef.current !== sessionId) return;
        setMessages(list);
        setHasMoreMessages(!!data.pageInfo?.hasMore);
        const oldest = list[0];
        oldestCursorRef.current = oldest ? { beforeCreatedAt: oldest.createdAt, beforeId: oldest.id } : null;
        if (!sessionStreamsRef.current[sessionId]) {
          void recoverActiveReplyRef.current(sessionId);
        }
      } catch (e) {
        if (loadMessagesSeqRef.current[sessionId] !== seq) return;
        if (activeSessionIdRef.current === sessionId) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!silent && loadMessagesSeqRef.current[sessionId] === seq && activeSessionIdRef.current === sessionId) {
          setLoadingMessages(false);
        }
      }
    },
    [authHeader, requestJson]
  );

  const loadOlderMessages = useCallback(async () => {
    if (!activeSessionId || loadingMoreMessages || !hasMoreMessages) return false;
    const sessionId = activeSessionId;
    const cursor = oldestCursorRef.current;
    if (!cursor) return false;
    setLoadingMoreMessages(true);
    try {
      const data = await requestJson<{ items: ChatMessage[]; pageInfo?: { hasMore?: boolean } }>(
        `/api/chat/sessions/${sessionId}/messages?limit=30&beforeCreatedAt=${encodeURIComponent(cursor.beforeCreatedAt)}&beforeId=${encodeURIComponent(cursor.beforeId)}`,
        { headers: { ...authHeader() } }
      );
      if (activeSessionIdRef.current !== sessionId) return false;
      const list = data.items || [];
      if (!list.length) {
        setHasMoreMessages(false);
        return false;
      }
      setMessages((prev) => [...list, ...prev]);
      setHasMoreMessages(!!data.pageInfo?.hasMore);
      oldestCursorRef.current = { beforeCreatedAt: list[0].createdAt, beforeId: list[0].id };
      return true;
    } catch (e) {
      if (activeSessionIdRef.current === sessionId) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return false;
    } finally {
      if (activeSessionIdRef.current === sessionId) {
        setLoadingMoreMessages(false);
      }
    }
  }, [activeSessionId, authHeader, hasMoreMessages, loadingMoreMessages, requestJson]);

  const stopActiveReplyPoll = useCallback(() => {
    if (activeReplyPollRef.current) {
      clearInterval(activeReplyPollRef.current);
      activeReplyPollRef.current = null;
    }
    activeReplyPollCountRef.current = 0;
    activeReplyPollSessionRef.current = "";
  }, []);

  const finishStreamingUi = useCallback(
    (sessionId: string) => {
      stopActiveReplyPoll();
      endSessionStream(sessionId);
    },
    [endSessionStream, stopActiveReplyPoll]
  );

  const recoverActiveReply = useCallback(
    async (sessionId: string) => {
      if (!sessionId || sessionStreamsRef.current[sessionId]) return;
      stopActiveReplyPoll();
      try {
        const data = await requestJson<{
          active?: boolean;
          partial?: string;
          agentSessionId?: string | null;
        }>(`/api/chat/sessions/${sessionId}/active-reply`, { headers: { ...authHeader() } });
        if (!data.active) return;
        if (activeSessionIdRef.current !== sessionId) return;

        const agentSessionId = typeof data.agentSessionId === "string" ? data.agentSessionId.trim() : "";
        if (agentSessionId) opencodeSessionByChatRef.current[sessionId] = agentSessionId;

        beginSessionStream(sessionId);
        updateSessionStream(sessionId, {
          partial: data.partial || "",
          status: data.partial?.trim() ? "running" : "pending",
        });

        activeReplyPollCountRef.current = 0;
        activeReplyPollSessionRef.current = sessionId;
        activeReplyPollRef.current = setInterval(() => {
          if (activeReplyPollSessionRef.current !== sessionId) return;
          activeReplyPollCountRef.current += 1;
          if (activeReplyPollCountRef.current > 150) {
            finishStreamingUi(sessionId);
            if (activeSessionIdRef.current === sessionId) {
              setErr("回复超时，请重试");
            }
            return;
          }
          void (async () => {
            if (activeReplyPollSessionRef.current !== sessionId) return;
            try {
              const row = await requestJson<{
                active?: boolean;
                partial?: string;
                agentSessionId?: string | null;
              }>(`/api/chat/sessions/${sessionId}/active-reply`, { headers: { ...authHeader() } });
              if (row.active) {
                const sid = typeof row.agentSessionId === "string" ? row.agentSessionId.trim() : "";
                if (sid) opencodeSessionByChatRef.current[sessionId] = sid;
                updateSessionStream(sessionId, {
                  partial: row.partial || "",
                  status: row.partial?.trim() ? "running" : "pending",
                });
                return;
              }
              finishStreamingUi(sessionId);
              if (activeSessionIdRef.current === sessionId) {
                await loadMessages(sessionId, { silent: true });
              }
            } catch {
              // ignore poll errors
            }
          })();
        }, 1200);
      } catch {
        // ignore recovery errors
      }
    },
    [authHeader, beginSessionStream, finishStreamingUi, loadMessages, requestJson, stopActiveReplyPoll, updateSessionStream]
  );

  useEffect(() => {
    recoverActiveReplyRef.current = recoverActiveReply;
  }, [recoverActiveReply]);

  const loadViewer = useCallback(async () => {
    const row = await requestJson<ViewerProfile>("/api/me", { headers: { ...authHeader() } });
    setViewer(row);
  }, [authHeader, requestJson]);

  const loadAppScopes = useCallback(async () => {
    const data = await requestJson<{ items: AndroidAppScope[] }>("/api/android/app-scopes", { headers: { ...authHeader() } });
    const items = data.items || [];
    setAppScopes(items);
    setAppScopeId((prev) => (prev && items.some((x) => x.id === prev) ? prev : items[0]?.id || "all"));
  }, [authHeader, requestJson]);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => {
      const next = prev.filter((item) => item.path !== path);
      const removed = prev.find((item) => item.path === path);
      if (removed?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return next;
    });
  }, []);

  const uploadAttachments = useCallback(
    async (files: File[]) => {
      const picked = files.filter(Boolean);
      if (!picked.length) return;
      if (uploadingAttachments) return;
      const existingCount = attachmentsRef.current.length;
      if (existingCount + picked.length > CHAT_ATTACHMENT_MAX_COUNT) {
        setErr(`最多支持 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件`);
        return;
      }
      const oversized = picked.find((file) => file.size > CHAT_ATTACHMENT_MAX_SIZE);
      if (oversized) {
        setErr(`单个附件不能超过 ${Math.round(CHAT_ATTACHMENT_MAX_SIZE / (1024 * 1024))}MB`);
        return;
      }
      const form = new FormData();
      picked.forEach((file) => form.append("files", file));
      setUploadingAttachments(true);
      try {
        const fileDataUrls = await Promise.all(picked.map((file) => readFileAsDataUrl(file)));
        const data = await requestJson<{ items: ChatAttachment[] }>("/api/chat/attachments", {
          method: "POST",
          headers: { ...authHeader() },
          body: form,
        });
        const uploaded = (data.items || []).map((item, index) => ({
          ...item,
          dataUrl: fileDataUrls[index],
          previewUrl: item.kind === "image" ? fileDataUrls[index] : undefined,
        }));
        setAttachments((prev) => [...prev, ...uploaded].slice(0, CHAT_ATTACHMENT_MAX_COUNT));
      } catch (e) {
        setErr(formatChatErrorMessage(e instanceof Error ? e.message : String(e)));
      } finally {
        setUploadingAttachments(false);
      }
    },
    [authHeader, requestJson, uploadingAttachments]
  );

  const createSession = useCallback(
    async (title?: string) => {
      const row = await requestJson<ChatSession>("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ title: title || "新会话" }),
      });
      setSessions((prev) => [row, ...prev]);
      setActiveSessionId(row.id);
      setMessages([]);
      return row.id;
    },
    [authHeader, requestJson]
  );

  const appendMessage = useCallback(
    async (sessionId: string, role: "user" | "assistant", content: string, metadata?: Record<string, unknown>) => {
      return requestJson<ChatMessage>(`/api/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ role, content, metadata: metadata || null }),
      });
    },
    [authHeader, requestJson]
  );

  const pushMessageLocal = useCallback((sessionId: string, item: ChatMessage) => {
    if (sessionId !== activeSessionIdRef.current) return;
    setMessages((prev) => {
      if (prev.some((x) => x.id === item.id)) return prev;
      return [...prev, item];
    });
  }, []);

  const touchSessionLocal = useCallback((sessionId: string) => {
    const now = new Date().toISOString();
    setSessions((prev) => {
      const idx = prev.findIndex((x) => x.id === sessionId);
      if (idx < 0) return prev;
      const row = { ...prev[idx], updatedAt: now };
      const next = [...prev];
      next[idx] = row;
      return next;
    });
  }, []);

  const setSessionTitleLocal = useCallback((sessionId: string, title: string) => {
    const safeTitle = String(title || "").trim();
    if (!safeTitle) return;
    const now = new Date().toISOString();
    setSessions((prev) => {
      const idx = prev.findIndex((x) => x.id === sessionId);
      if (idx < 0) return prev;
      const row = { ...prev[idx], title: safeTitle, updatedAt: now };
      const next = [...prev];
      next[idx] = row;
      return next;
    });
  }, []);

  const runOpencodeAndStream = useCallback(
    async (
      signal: AbortSignal,
      params: { prompt: string; chatSessionId: string; appScopeId: string; classRefs?: AndroidClassCandidate[]; attachments?: ChatAttachment[]; knowledgeLocator?: KnowledgeLocator | null },
      onProgress: (partial: string, images: OpencodeImageAttachment[], reasoning: string) => void
    ): Promise<{ content: string; opencodeSessionId: string; images: OpencodeImageAttachment[] }> => {
      const opencodeSessionId = resolveOpencodeSessionForChat(
        params.chatSessionId,
        opencodeSessionByChatRef.current,
        params.chatSessionId === activeSessionIdRef.current ? messagesRef.current : [],
      );
      const classRefs = (params.classRefs || []).map((x) => ({
        fqn: x.fqn,
        module: x.module,
      }));
      const res = await fetch("/api/opencode/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          message: params.prompt,
          sessionId: opencodeSessionId,
          appScopeId: params.appScopeId,
          chatSessionId: params.chatSessionId,
          classRefs,
          attachments: params.attachments || [],
          knowledgeLocator: params.knowledgeLocator || undefined,
        }),
        signal,
      });
      if (!res.ok) {
        let errCode = `opencode_request_failed_${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error?.trim()) errCode = data.error.trim();
        } catch {
          // ignore non-json body
        }
        throw new Error(formatChatErrorMessage(errCode));
      }
      if (!res.body) {
        throw new Error(formatChatErrorMessage("opencode_request_failed_empty_body"));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let images: OpencodeImageAttachment[] = [];
      let finalSessionId = opencodeSessionId || "";
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (e) {
          throw new Error(formatChatErrorMessage(e instanceof Error ? e.message : String(e)));
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n");
        buffer = chunks.pop() ?? "";
        for (const line of chunks) {
          if (!line.startsWith("data: ")) continue;
          let parsed: {
            type?: string;
            text?: string;
            sessionId?: string;
            message?: string;
            path?: string;
            mime?: string;
            alt?: string;
          };
          try {
            parsed = JSON.parse(line.slice(6)) as typeof parsed;
          } catch {
            continue;
          }
          if (parsed.type === "session" && parsed.sessionId) {
            finalSessionId = parsed.sessionId;
            opencodeSessionByChatRef.current[params.chatSessionId] = parsed.sessionId;
          } else if (parsed.type === "token" && parsed.text) {
            content += parsed.text;
            if (sessionStreamsRef.current[params.chatSessionId]) {
              onProgress(content, images, reasoning);
            }
          } else if (parsed.type === "reasoning" && parsed.text) {
            reasoning += parsed.text;
            if (sessionStreamsRef.current[params.chatSessionId]) {
              onProgress(content, images, reasoning);
            }
          } else if (parsed.type === "image" && parsed.path) {
            images = dedupeOpencodeImages([
              ...images,
              {
                path: parsed.path,
                mime: parsed.mime || "application/octet-stream",
                alt: typeof parsed.alt === "string" ? parsed.alt : undefined,
              },
            ]);
            if (sessionStreamsRef.current[params.chatSessionId]) {
              onProgress(content, images, reasoning);
            }
          } else if (parsed.type === "error") {
            throw new Error(parsed.message || "opencode_error");
          }
        }
      }
      if (!finalSessionId) {
        throw new Error("opencode_missing_session");
      }
      return { content: content.trim(), opencodeSessionId: finalSessionId, images };
    },
    [authHeader]
  );

  const autoTitleSession = useCallback(
    async (sessionId: string, prompt: string) => {
      try {
        const renamed = await requestJson<ChatSession>(`/api/chat/sessions/${sessionId}/auto-title`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader() },
          body: JSON.stringify({ prompt, backend: "opencode" }),
        });
        setSessionTitleLocal(sessionId, renamed.title);
      } catch {
        try {
          const fallbackTitle = buildSessionTitleFromPrompt(prompt);
          const renamed = await requestJson<ChatSession>(`/api/chat/sessions/${sessionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...authHeader() },
            body: JSON.stringify({ title: fallbackTitle }),
          });
          setSessionTitleLocal(sessionId, renamed.title || fallbackTitle);
        } catch {
          // keep default title if rename fails
        }
      }
    },
    [authHeader, requestJson, setSessionTitleLocal]
  );

  const cancelSending = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    const stream = sessionId ? sessionStreamsRef.current[sessionId] : undefined;
    if (!sessionId || !stream || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    setCanceling(true);
    try {
      await fetch("/api/opencode/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ chatSessionId: sessionId }),
      });
    } catch {
      // still stop local UI
    }
    stream.abort.abort();
    finishStreamingUi(sessionId);
    cancelRequestedRef.current = false;
    setCanceling(false);
    if (activeSessionIdRef.current === sessionId) {
      setErr("任务已取消");
    }
  }, [authHeader, finishStreamingUi]);

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    const pendingComposerAttachments = attachmentsRef.current;
    const nextAttachments = pendingComposerAttachments.map(({ previewUrl, ...rest }) => rest);
    const persistedAttachments = nextAttachments.map(({ dataUrl, ...rest }) => rest);
    const pendingKnowledgeLocator = knowledgeLocatorRef.current || knowledgeLocator;
    if (!text && !nextAttachments.length) return;

    let sid = activeSessionId;
    if (!sid && sessions[0]?.id) {
      sid = sessions[0].id;
      setActiveSessionId(sid);
    }
    if (!sid) sid = await createSession(buildSessionTitleFromPrompt(text || persistedAttachments[0]?.name || "新会话"));
    if (isSessionStreaming(sid)) return;

    setForceStickBottomTick((x) => x + 1);
    setErr("");
    inputTextRef.current = "";
    setInputText("");
    knowledgeLocatorRef.current = null;
    setKnowledgeLocator(null);
    setAttachments([]);
    const optimisticUserId = `local-user-${randomId()}`;
    let aborter: AbortController | null = null;
    try {
      const currentSession = sessions.find((x) => x.id === sid);
      if (text && currentSession && shouldAutoRenameSession(currentSession.title)) {
        void autoTitleSession(sid, text);
      }
      const userMetadata = {
        mode: "opencode",
        backend: "opencode",
        appScopeId,
        attachments: persistedAttachments,
        ...(pendingKnowledgeLocator ? { knowledgeLocator: pendingKnowledgeLocator } : {}),
      };

      pushMessageLocal(sid, {
        id: optimisticUserId,
        sessionId: sid,
        role: "user",
        content: text,
        metadata: userMetadata,
        createdAt: new Date().toISOString(),
      });
      touchSessionLocal(sid);

      aborter = beginSessionStream(sid);

      const userMessage = await appendMessage(sid, "user", text, userMetadata);
      if (activeSessionIdRef.current === sid) {
        setMessages((prev) => prev.map((m) => (m.id === optimisticUserId ? userMessage : m)));
      }

      await runOpencodeAndStream(
        aborter.signal,
        {
          prompt: text,
          chatSessionId: sid,
          appScopeId,
          attachments: nextAttachments,
          knowledgeLocator: pendingKnowledgeLocator,
          classRefs: selectedClasses.filter((x) =>
            new RegExp(`(^|\\s)@?${escapeRegExp(x.fqn)}(?=\\s|$)`, "i").test(text)
          ),
        },
        (partial, images, reasoning) => {
          const mergedImages = dedupeOpencodeImages([...images, ...extractOpencodeImagesFromText(partial)]);
          updateSessionStream(sid, { partial, reasoning, images: mergedImages, status: "running" });
        }
      );
      if (activeSessionIdRef.current === sid) {
        await loadMessages(sid, { silent: true });
      }
      revokeAttachmentPreviews(pendingComposerAttachments);
      touchSessionLocal(sid);
    } catch (e) {
      if (activeSessionIdRef.current === sid) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId));
      }
      setAttachments((prev) => (prev.length ? prev : pendingComposerAttachments));
      if (aborter && (isAbortLikeError(e) || aborter.signal.aborted)) {
        if (activeSessionIdRef.current === sid) setErr("任务已取消");
        return;
      }
      const msg = formatChatErrorMessage(e instanceof Error ? e.message : String(e));
      if (activeSessionIdRef.current === sid) {
        await loadMessages(sid, { silent: true });
        setErr(msg);
      }
    } finally {
      finishStreamingUi(sid);
      cancelRequestedRef.current = false;
      setCanceling(false);
    }
  }, [
    appendMessage,
    appScopeId,
    autoTitleSession,
    beginSessionStream,
    createSession,
    finishStreamingUi,
    inputText,
    knowledgeLocator,
    isSessionStreaming,
    loadMessages,
    pushMessageLocal,
    runOpencodeAndStream,
    selectedClasses,
    sessions,
    touchSessionLocal,
    updateSessionStream,
  ]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      sessionStreamsRef.current[sessionId]?.abort.abort();
      endSessionStream(sessionId);
      delete opencodeSessionByChatRef.current[sessionId];
      await fetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeader() } });
      if (activeSessionId === sessionId) {
        setActiveSessionId("");
        setMessages([]);
        setHasMoreMessages(false);
      }
      await loadSessions();
    },
    [activeSessionId, authHeader, endSessionStream, loadSessions]
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      const row = await requestJson<ChatSession>(`/api/chat/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ title: t }),
      });
      setSessionTitleLocal(sessionId, row.title || t);
    },
    [authHeader, requestJson, setSessionTitleLocal]
  );

  useEffect(() => {
    if (!localStorage.getItem("hm_token")) return router.replace("/login");
    Promise.all([loadViewer(), loadAppScopes()]).catch(() => setErr("应用列表加载失败，请刷新重试。"));
    void loadSessions();
  }, [loadAppScopes, loadSessions, loadViewer, router]);

  useEffect(() => {
    setSelectedClasses([]);
    stopActiveReplyPoll();
    void loadMessages(activeSessionId);
  }, [activeSessionId, loadMessages, stopActiveReplyPoll]);

  useEffect(() => {
    const p1 = document.body.style.overflow;
    const p2 = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = p1;
      document.documentElement.style.overflow = p2;
    };
  }, []);

  useEffect(() => {
    if (!activeMention) {
      setClassCandidates([]);
      setClassSearching(false);
      return;
    }
    const keyword = activeMention.keyword.trim();
    if (keyword.length < 1) {
      setClassCandidates([]);
      setClassSearching(false);
      return;
    }
    const timer = setTimeout(async () => {
      setClassSearching(true);
      try {
        const data = await requestJson<{ items: AndroidClassCandidate[] }>(
          `/api/android/class-search?q=${encodeURIComponent(keyword)}&limit=20&appScopeId=${encodeURIComponent(appScopeId)}`,
          { headers: { ...authHeader() } }
        );
        setClassCandidates(data.items || []);
      } catch {
        setClassCandidates([]);
      } finally {
        setClassSearching(false);
      }
    }, 360);
    return () => clearTimeout(timer);
  }, [activeMention, appScopeId, authHeader, requestJson]);

  useEffect(() => {
    setSelectedClasses([]);
    setClassCandidates([]);
  }, [appScopeId]);

  const pickClassCandidate = useCallback((row: AndroidClassCandidate) => {
    setSelectedClasses((prev) => {
      if (prev.some((x) => x.fqn === row.fqn && x.module === row.module)) return prev;
      return [...prev, row];
    });
    setInputText((prev) => {
      const mention = getActiveMention(prev);
      if (!mention) return prev;
      const prefix = prev.slice(0, prev.length - mention.tokenText.length).trimEnd();
      return `${prefix} ${row.fqn} `;
    });
    setClassCandidates([]);
    setErr("");
  }, []);

  const removeSelectedClass = useCallback((fqn: string, moduleValue: string) => {
    setSelectedClasses((prev) => prev.filter((x) => !(x.fqn === fqn && x.module === moduleValue)));
    const escaped = escapeRegExp(fqn);
    setInputText((prev) =>
      prev
        .replace(new RegExp(`(^|\\s)@?${escaped}(?=\\s|$)`, "g"), " ")
        .replace(/\s{2,}/g, " ")
        .trimStart()
    );
  }, []);

  const openClassExplain = useCallback((classFqn: string, docPath = "") => {
    const fqn = String(classFqn || "").trim();
    if (!/^(?:[A-Za-z_][A-Za-z0-9_$]*\.){2,}[A-Za-z_][A-Za-z0-9_$]*$/.test(fqn)) return;
    const prompt = `请分析 @${fqn} 的业务逻辑、调用链、关键依赖与迁移注意点。`;
    deepLinkRef.current = {
      key: `class-explain:${fqn}:${docPath}`,
      prompt,
      autoSend: true,
    };
    setSelectedClasses([]);
    setClassCandidates([]);
    setErr("");
    setInputText(prompt);
  }, []);

  const canSend = useMemo(() => {
    const sessionBusy = !!activeSessionId && !!sessionStreamsRef.current[activeSessionId];
    return !sessionBusy && !uploadingAttachments && (!!inputText.trim() || !!attachments.length) && !activeMention?.keyword.length;
  }, [activeSessionId, streamUiTick, inputText, activeMention, attachments.length, uploadingAttachments]);

  useEffect(() => {
    const deep = deepLinkRef.current;
    if (!deep?.autoSend) return;
    const sentKey = `hm_deep_link_sent:${deep.key}`;
    if (typeof window !== "undefined" && window.sessionStorage.getItem(sentKey) === "1") {
      deepLinkRef.current = null;
      return;
    }
    if (isSessionStreaming(activeSessionId) || !!activeMention?.keyword.length) return;
    if (inputText.trim() !== deep.prompt) return;
    if (!canSend) return;
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(sentKey, "1");
    }
    deepLinkRef.current = null;
    void sendMessage();
  }, [activeMention, activeSessionId, canSend, inputText, isSessionStreaming, sendMessage]);

  const activeStream = useMemo(() => sessionStreamsRef.current[activeSessionId], [activeSessionId, streamUiTick]);
  const activeSessionSending = !!activeStream;
  const streamingReply = activeStream?.partial ?? "";
  const streamingReasoning = activeStream?.reasoning ?? "";
  const streamingImages = activeStream?.images ?? [];
  const streamingStatus: "idle" | "pending" | "running" = activeStream?.status ?? "idle";
  const sessionTitle = useMemo(() => sessions.find((s) => s.id === activeSessionId)?.title || "新对话", [sessions, activeSessionId]);
  const setInputWithReset = useCallback((value: string) => {
    const changed = value !== inputTextRef.current;
    inputTextRef.current = value;
    setInputText(value);
    if (changed) {
      knowledgeLocatorRef.current = null;
      setKnowledgeLocator(null);
    }
    setSelectedClasses((prev) => {
      if (!prev.length) return prev;
      return prev.filter((x) => new RegExp(`(^|\\s)@?${escapeRegExp(x.fqn)}(?=\\s|$)`, "i").test(value));
    });
    if (!getActiveMention(value)) setClassCandidates([]);
  }, []);

  const setKnowledgeQuestion = useCallback((value: string, locator?: KnowledgeLocator) => {
    inputTextRef.current = value;
    knowledgeLocatorRef.current = locator || null;
    setInputText(value);
    setKnowledgeLocator(locator || null);
    setSelectedClasses([]);
    setClassCandidates([]);
  }, []);

  return {
    appScopes,
    appScopeId,
    setAppScopeId,
    selectedClasses,
    removeSelectedClass,
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    hasMoreMessages,
    loadingMoreMessages,
    loadOlderMessages,
    inputText,
    setInputText: setInputWithReset,
    setKnowledgeQuestion,
    attachments,
    uploadingAttachments,
    uploadAttachments,
    removeAttachment,
    sending: activeSessionSending,
    canceling,
    activeSessionSending,
    streamingReply,
    streamingReasoning,
    streamingImages,
    streamingStatus,
    loadingSessions,
    loadingMessages,
    err,
    setErr,
    viewer,
    classCandidates,
    classSearching,
    forceStickBottomTick,
    showClassSearchPanel: !!activeMention?.keyword.length,
    canSend,
    sessionTitle,
    sendMessage,
    pickClassCandidate,
    cancelSending,
    createSession,
    deleteSession,
    renameSession,
    openClassExplain,
  };
}
