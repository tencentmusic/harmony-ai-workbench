"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { MessageInstance } from "antd/es/message/interface";
import type { OverviewChartRange } from "@/lib/admin-overview-range";
import type { AppScopeRow, FeedbackRow, KbRoiStatsState, KnowledgeStatsState, MenuKey, RepoSyncRepoRow, RepoSyncRunRow, RequestRow, TokenRow, UsageRow, ZcMcpAuditRow } from "../types";

type TokenForm = { label: string; personName: string; personCode: string; expiresInDays: string; appScopeIds: string[] };
type DateRange = { startDate: string; endDate: string };

function formatDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDefaultDateRange(): DateRange {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function dateRangeToQuery(range: DateRange): URLSearchParams {
  const query = new URLSearchParams();
  query.set("startAt", `${range.startDate}T00:00:00.000`);
  query.set("endAt", `${range.endDate}T23:59:59.999`);
  return query;
}

export function useAdminConsole(router: AppRouterInstance, message: MessageInstance) {
  const [menuKey, setMenuKey] = useState<MenuKey>("overview");
  const [booting, setBooting] = useState(true);
  const [menuLoading, setMenuLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFlash = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setOk("");
    setErr("");
  }, []);

  useEffect(() => {
    if (!ok && !err) return;
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setOk("");
      setErr("");
      flashTimerRef.current = null;
    }, ok ? 4000 : 6000);
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, [ok, err]);

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [appScopes, setAppScopes] = useState<AppScopeRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [requestRows, setRequestRows] = useState<RequestRow[]>([]);
  const [zcMcpAuditRows, setZcMcpAuditRows] = useState<ZcMcpAuditRow[]>([]);
  const [zcMcpAuditTotal, setZcMcpAuditTotal] = useState(0);
  const [zcMcpAuditByTool, setZcMcpAuditByTool] = useState<Array<{ tool: string; count: number }>>([]);
  const [zcMcpAuditByConsumer, setZcMcpAuditByConsumer] = useState<Array<{ consumer: string; count: number }>>([]);
  const [feedbackRows, setFeedbackRows] = useState<FeedbackRow[]>([]);
  const [overviewChartRange, setOverviewChartRange] = useState<OverviewChartRange>("last7d");
  const [overview, setOverview] = useState<{
    tokenCount: number;
    appCount: number;
    migrationDocCount: number;
    taskTotalAllTime: number;
    chartRangeLabel: string;
    usageSummary: { total: number; done: number; failed: number; running: number };
    line7d: Array<{ day: string; count: number }>;
    person7d: Array<{ person: string; count: number }>;
    personRank: Array<{ person: string; count: number }>;
  }>({
    tokenCount: 0,
    appCount: 0,
    migrationDocCount: 0,
    taskTotalAllTime: 0,
    chartRangeLabel: "近 7 天",
    usageSummary: { total: 0, done: 0, failed: 0, running: 0 },
    line7d: [],
    person7d: [],
    personRank: [],
  });
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStatsState>({
    days: 7,
    migrationDocCount: 0,
    hotDocs: [],
    coldDocs: [],
    personStats: [],
  });
  const [knowledgeDays, setKnowledgeDays] = useState(7);
  const [kbRoiStats, setKbRoiStats] = useState<KbRoiStatsState>({
    days: 7,
    error: null,
    kpi: {
      total_turns: 0,
      index_coverage_pct: 0,
      call_reduction_pct: null,
      codegraph_backfill_turns: 0,
      codegraph_backfill_denominator: 0,
      codegraph_backfill_rate_pct: null,
      no_index_turns: 0,
      with_index_turns: 0,
      avg_raw_scan_no_index: 0,
      avg_raw_scan_with_index: 0,
    },
    byFeature: [],
    byDelivery: [],
    cohort: [],
    daily: [],
    byToolFamily: [],
    byCodegraphTool: [],
    retrievalFunnel: [],
  });
  const [kbRoiRange, setKbRoiRange] = useState<OverviewChartRange>("last7d");
  const [repoSyncRuns, setRepoSyncRuns] = useState<RepoSyncRunRow[]>([]);
  const [repoSyncRepos, setRepoSyncRepos] = useState<RepoSyncRepoRow[]>([]);
  const [repoSyncQueueDepth, setRepoSyncQueueDepth] = useState(0);
  const [recordTokenId, setRecordTokenId] = useState("");
  const [usageTokenId, setUsageTokenId] = useState("");
  const [usageDateRange, setUsageDateRange] = useState<DateRange>(() => getDefaultDateRange());
  const [requestDateRange, setRequestDateRange] = useState<DateRange>(() => getDefaultDateRange());
  const [requestStatus, setRequestStatus] = useState("");
  const [zcMcpAuditDateRange, setZcMcpAuditDateRange] = useState<DateRange>(() => getDefaultDateRange());
  const [zcMcpAuditConsumer, setZcMcpAuditConsumer] = useState("");
  const [zcMcpAuditTokenId, setZcMcpAuditTokenId] = useState("");
  const [zcMcpAuditTool, setZcMcpAuditTool] = useState("");
  const [zcMcpAuditEventType, setZcMcpAuditEventType] = useState("");
  const [zcMcpAuditHit, setZcMcpAuditHit] = useState("");
  const [zcMcpAuditDays, setZcMcpAuditDays] = useState(7);

  const [tokenForm, setTokenForm] = useState<TokenForm>({ label: "", personName: "", personCode: "", expiresInDays: "", appScopeIds: [] });
  const [tokenOnce, setTokenOnce] = useState("");
  const [rebuildingClassIndex, setRebuildingClassIndex] = useState(false);
  const loadedMenusRef = useRef<Record<MenuKey, boolean>>({
    overview: false,
    knowledge: false,
    kbRoi: false,
    repoSync: false,
    tokens: false,
    usage: false,
    requests: false,
    feedback: false,
    zcMcpAudit: false,
  });
  const appScopesLoadedRef = useRef(false);

  const redirectAdminLogin = useCallback(
    (reason: "missing" | "forbidden") => {
      localStorage.removeItem("hm_admin_secret");
      router.replace(`/admin/login?reason=${reason}`);
    },
    [router]
  );

  const adminSecret = useCallback(() => localStorage.getItem("hm_admin_secret") || "", []);
  const adminHeaders = useCallback(() => ({ "Content-Type": "application/json", "x-admin-secret": adminSecret() }), [adminSecret]);

  const assertAdminAuth = useCallback(
    (res: Response) => {
      if (res.status !== 403) return;
      redirectAdminLogin("forbidden");
      throw new Error("管理员密钥无效，请重新登录。");
    },
    [redirectAdminLogin]
  );

  const fetchTokens = useCallback(async () => {
    const res = await fetch("/api/admin/tokens", { headers: adminHeaders() });
    assertAdminAuth(res);
    if (!res.ok) throw new Error(`tokens_http_${res.status}`);
    const data = await res.json();
    setTokens(data.items || []);
  }, [adminHeaders, assertAdminAuth]);

  const fetchAppScopes = useCallback(async () => {
    const res = await fetch("/api/admin/app-scopes", { headers: adminHeaders() });
    assertAdminAuth(res);
    if (!res.ok) throw new Error(`app_scopes_http_${res.status}`);
    const data = await res.json();
    setAppScopes(data.items || []);
  }, [adminHeaders, assertAdminAuth]);

  const fetchUsage = useCallback(async () => {
    const res = await fetch("/api/admin/usage", { headers: adminHeaders() });
    assertAdminAuth(res);
    if (!res.ok) throw new Error(`usage_http_${res.status}`);
    const data = await res.json();
    setUsage(data.items || []);
  }, [adminHeaders, assertAdminAuth]);

  const fetchUsageRows = useCallback(
    async (range: DateRange, tokenId?: string) => {
      const query = dateRangeToQuery(range);
      if (tokenId) query.set("tokenId", tokenId);
      const q = query.toString() ? `?${query.toString()}` : "";
      const res = await fetch(`/api/admin/usage${q}`, { headers: adminHeaders() });
      assertAdminAuth(res);
      if (!res.ok) throw new Error(`usage_http_${res.status}`);
      const data = await res.json();
      setUsageRows(data.items || []);
    },
    [adminHeaders, assertAdminAuth]
  );

  const fetchRequestRows = useCallback(
    async (tokenId?: string, range: DateRange = requestDateRange, status: string = requestStatus) => {
      const query = dateRangeToQuery(range);
      if (tokenId) query.set("tokenId", tokenId);
      if (status) query.set("status", status);
      const q = query.toString() ? `?${query.toString()}` : "";
      const res = await fetch(`/api/admin/request-records${q}`, { headers: adminHeaders() });
      assertAdminAuth(res);
      if (!res.ok) throw new Error(`request_records_http_${res.status}`);
      const data = await res.json();
      setRequestRows(data.items || []);
    },
    [adminHeaders, assertAdminAuth, requestDateRange, requestStatus]
  );

  const fetchFeedbackRows = useCallback(async () => {
    const res = await fetch("/api/admin/feedback", { headers: adminHeaders() });
    assertAdminAuth(res);
    if (!res.ok) throw new Error(`feedback_http_${res.status}`);
    const data = await res.json();
    setFeedbackRows(data.items || []);
  }, [adminHeaders, assertAdminAuth]);

  const fetchZcMcpAuditRows = useCallback(
    async (
      range: DateRange = zcMcpAuditDateRange,
      filters: {
        consumer?: string;
        apiTokenId?: string;
        tool?: string;
        eventType?: string;
        hit?: string;
      } = {},
    ) => {
      const query = new URLSearchParams();
      query.set("since", `${range.startDate}T00:00:00.000Z`);
      query.set("until", `${range.endDate}T23:59:59.999Z`);
      query.set("limit", "100");
      if (filters.consumer) query.set("consumer", filters.consumer);
      if (filters.apiTokenId) query.set("apiTokenId", filters.apiTokenId);
      if (filters.tool) query.set("tool", filters.tool);
      if (filters.eventType) query.set("eventType", filters.eventType);
      if (filters.hit) query.set("hit", filters.hit);
      const res = await fetch(`/api/admin/kb-mcp-audit?${query.toString()}`, { headers: adminHeaders() });
      assertAdminAuth(res);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `kb_mcp_audit_http_${res.status}`);
      }
      const data = await res.json();
      setZcMcpAuditRows(data.items || []);
      setZcMcpAuditTotal(Number(data.total || 0));
      setZcMcpAuditByTool(data.byTool || []);
      setZcMcpAuditByConsumer(data.byConsumer || []);
    },
    [adminHeaders, assertAdminAuth, zcMcpAuditDateRange],
  );

  const fetchOverview = useCallback(
    async (range: OverviewChartRange = overviewChartRange) => {
      const q = new URLSearchParams({ range });
      const res = await fetch(`/api/admin/overview?${q.toString()}`, { headers: adminHeaders() });
      assertAdminAuth(res);
      if (!res.ok) throw new Error(`overview_http_${res.status}`);
      const data = await res.json();
      setOverview({
        tokenCount: Number(data.tokenCount || 0),
        appCount: Number(data.appCount || 0),
        migrationDocCount: Number(data.migrationDocCount || 0),
        taskTotalAllTime: Number(data.taskTotalAllTime ?? data.usageSummary?.total ?? 0),
        chartRangeLabel: String(data.chartRangeLabel || "近 7 天"),
        usageSummary: {
          total: Number(data.usageSummary?.total || 0),
          done: Number(data.usageSummary?.done || 0),
          failed: Number(data.usageSummary?.failed || 0),
          running: Number(data.usageSummary?.running || 0),
        },
        line7d: Array.isArray(data.line7d) ? data.line7d : [],
        person7d: Array.isArray(data.person7d) ? data.person7d : [],
        personRank: Array.isArray(data.personRank) ? data.personRank : [],
      });
    },
    [adminHeaders, assertAdminAuth, overviewChartRange],
  );

  const fetchKnowledgeStats = useCallback(
    async (days = knowledgeDays) => {
      const res = await fetch(`/api/admin/doc-analytics?days=${days}`, { headers: adminHeaders() });
      assertAdminAuth(res);
      if (!res.ok) throw new Error(`knowledge_stats_http_${res.status}`);
      const data = await res.json();
      setKnowledgeStats({
        days: Number(data.days || days),
        migrationDocCount: Number(data.migrationDocCount || 0),
        hotDocs: Array.isArray(data.hotDocs) ? data.hotDocs : [],
        coldDocs: Array.isArray(data.coldDocs) ? data.coldDocs : [],
        personStats: Array.isArray(data.personStats) ? data.personStats : [],
      });
    },
    [adminHeaders, assertAdminAuth, knowledgeDays],
  );

  const fetchRepoSync = useCallback(async () => {
    const res = await fetch("/api/admin/repo-sync/runs?limit=50", { headers: adminHeaders() });
    assertAdminAuth(res);
    if (!res.ok) throw new Error(`repo_sync_http_${res.status}`);
    const data = await res.json().catch(() => ({}));
    setRepoSyncRuns(Array.isArray(data.runs) ? data.runs : []);
    setRepoSyncRepos(Array.isArray(data.repos) ? data.repos : []);
    setRepoSyncQueueDepth(Number(data.queue_depth) || 0);
  }, [adminHeaders, assertAdminAuth]);

  const fetchKbRoiStats = useCallback(
    async (range = kbRoiRange) => {
      try {
        const res = await fetch(`/api/admin/kb-telemetry?range=${encodeURIComponent(range)}`, { headers: adminHeaders() });
        assertAdminAuth(res);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
          setKbRoiStats({
            days: 0,
            error: [data.error, data.hint].filter(Boolean).join(" · ") || `kb_roi_http_${res.status}`,
            kpi: {
              total_turns: 0,
              index_coverage_pct: 0,
              call_reduction_pct: null,
              codegraph_backfill_turns: 0,
              codegraph_backfill_denominator: 0,
              codegraph_backfill_rate_pct: null,
              no_index_turns: 0,
              with_index_turns: 0,
              avg_raw_scan_no_index: 0,
              avg_raw_scan_with_index: 0,
            },
            byFeature: [],
            byDelivery: [],
            cohort: [],
            daily: [],
            byToolFamily: [],
            byCodegraphTool: [],
            retrievalFunnel: [],
          });
          return;
        }
        const data = await res.json();
        const kpi = data.kpi || {};
        setKbRoiStats({
          days: Number(data.days || 0),
          error: null,
          kpi: {
            total_turns: Number(kpi.total_turns || 0),
            index_coverage_pct: Number(kpi.index_coverage_pct || 0),
            call_reduction_pct: kpi.call_reduction_pct == null ? null : Number(kpi.call_reduction_pct),
            codegraph_backfill_turns: Number(kpi.codegraph_backfill_turns || 0),
            codegraph_backfill_denominator: Number(kpi.codegraph_backfill_denominator || 0),
            codegraph_backfill_rate_pct:
              kpi.codegraph_backfill_rate_pct == null ? null : Number(kpi.codegraph_backfill_rate_pct),
            no_index_turns: Number(kpi.no_index_turns || 0),
            with_index_turns: Number(kpi.with_index_turns || 0),
            avg_raw_scan_no_index: Number(kpi.avg_raw_scan_no_index || 0),
            avg_raw_scan_with_index: Number(kpi.avg_raw_scan_with_index || 0),
          },
          byFeature: Array.isArray(data.byFeature) ? data.byFeature : [],
          byDelivery: Array.isArray(data.byDelivery) ? data.byDelivery : [],
          cohort: Array.isArray(data.cohort) ? data.cohort : [],
          daily: Array.isArray(data.daily) ? data.daily : [],
          byToolFamily: Array.isArray(data.byToolFamily) ? data.byToolFamily : [],
          byCodegraphTool: Array.isArray(data.byCodegraphTool) ? data.byCodegraphTool : [],
          retrievalFunnel: Array.isArray(data.retrievalFunnel) ? data.retrievalFunnel : [],
        });
      } catch (err) {
        setKbRoiStats((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "kb_roi_fetch_failed",
        }));
      }
    },
    [adminHeaders, assertAdminAuth, kbRoiRange],
  );

  const ensureMenuData = useCallback(
    async (targetMenu: MenuKey, options?: { force?: boolean }) => {
      const force = !!options?.force;
      if (!adminSecret()) {
        setBooting(false);
        redirectAdminLogin("missing");
        return;
      }
      const isLoaded = (key: MenuKey) => !force && loadedMenusRef.current[key];
      const appScopesReady = !force && appScopesLoadedRef.current;
      if (isLoaded(targetMenu) && !(targetMenu === "tokens" && !appScopesReady)) {
        setBooting(false);
        return;
      }
      setMenuLoading(true);
      const markLoaded = (keys: MenuKey[]) => {
        for (const k of keys) loadedMenusRef.current[k] = true;
      };
      const ensureAppScopes = async () => {
        if (appScopesReady) return;
        await fetchAppScopes();
        appScopesLoadedRef.current = true;
      };
      try {
        if (targetMenu === "overview") {
          await fetchOverview();
          markLoaded(["overview"]);
        } else if (targetMenu === "knowledge") {
          if (!isLoaded("knowledge")) await fetchKnowledgeStats(knowledgeDays);
          markLoaded(["knowledge"]);
        } else if (targetMenu === "kbRoi") {
          if (!isLoaded("kbRoi")) await fetchKbRoiStats(kbRoiRange);
          markLoaded(["kbRoi"]);
        } else if (targetMenu === "repoSync") {
          if (!isLoaded("repoSync")) await fetchRepoSync();
          markLoaded(["repoSync"]);
        } else if (targetMenu === "tokens") {
          await Promise.all([isLoaded("tokens") ? Promise.resolve() : fetchTokens(), ensureAppScopes()]);
          markLoaded(["tokens"]);
        } else if (targetMenu === "usage") {
          await Promise.all([
            isLoaded("usage") ? Promise.resolve() : fetchUsage(),
            isLoaded("usage") ? Promise.resolve() : fetchUsageRows(usageDateRange, usageTokenId || undefined),
            isLoaded("tokens") ? Promise.resolve() : fetchTokens(),
          ]);
          markLoaded(["usage", "tokens"]);
        } else if (targetMenu === "requests") {
          await Promise.all([
            isLoaded("requests") ? Promise.resolve() : fetchRequestRows(recordTokenId || undefined, requestDateRange, requestStatus),
            isLoaded("tokens") ? Promise.resolve() : fetchTokens(),
          ]);
          markLoaded(["requests", "tokens"]);
        } else if (targetMenu === "feedback") {
          if (!isLoaded("feedback")) await fetchFeedbackRows();
          markLoaded(["feedback"]);
        } else if (targetMenu === "zcMcpAudit") {
          await Promise.all([
            isLoaded("zcMcpAudit")
              ? Promise.resolve()
              : fetchZcMcpAuditRows(zcMcpAuditDateRange, {
                  consumer: zcMcpAuditConsumer,
                  apiTokenId: zcMcpAuditTokenId || undefined,
                  tool: zcMcpAuditTool || undefined,
                  eventType: zcMcpAuditEventType || undefined,
                  hit: zcMcpAuditHit || undefined,
                }),
            isLoaded("tokens") ? Promise.resolve() : fetchTokens(),
          ]);
          markLoaded(["zcMcpAudit", "tokens"]);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setMenuLoading(false);
        setBooting(false);
      }
    },
    [
      adminSecret,
      fetchAppScopes,
      fetchFeedbackRows,
      fetchKbRoiStats,
      fetchKnowledgeStats,
      fetchOverview,
      fetchRepoSync,
      fetchRequestRows,
      fetchTokens,
      fetchUsage,
      fetchUsageRows,
      knowledgeDays,
      kbRoiRange,
      recordTokenId,
      redirectAdminLogin,
      requestDateRange,
      requestStatus,
      usageDateRange,
      usageTokenId,
    ]
  );

  useEffect(() => {
    if (!adminSecret()) {
      setBooting(false);
      redirectAdminLogin("missing");
      return;
    }
    void ensureMenuData(menuKey, { force: false });
  }, [adminSecret, ensureMenuData, menuKey, redirectAdminLogin]);

  const usageSummary = useMemo(
    () =>
      usage.reduce(
        (acc, item) => {
          acc.total += item.stats.total;
          acc.done += item.stats.done;
          acc.failed += item.stats.failed;
          acc.running += item.stats.running;
          return acc;
        },
        { total: 0, done: 0, failed: 0, running: 0 }
      ),
    [usage]
  );

  const withBusy = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    setOk("");
    try {
      await task();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const changeOverviewChartRange = useCallback(
    async (range: OverviewChartRange) => {
      setOverviewChartRange(range);
      await withBusy(async () => {
        await fetchOverview(range);
      });
    },
    [fetchOverview, withBusy],
  );

  const triggerRepoSync = useCallback(
    async (repoId: string, branch?: string) => {
      await withBusy(async () => {
        const res = await fetch("/api/admin/repo-sync/trigger", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ repo_id: repoId, branch }),
        });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error || `repo_sync_trigger_${res.status}`);
        setOk("已入队自动部署更新，请确保后台 worker 在运行");
        await fetchRepoSync();
      });
    },
    [adminHeaders, assertAdminAuth, fetchRepoSync, withBusy],
  );

  const createToken = useCallback(async () => {
    setCreatingToken(true);
    try {
      await withBusy(async () => {
        setTokenOnce("");
        const payload: { label?: string; personName: string; personCode: string; expiresInDays?: number; appScopeIds?: string[] } = {
          personName: tokenForm.personName.trim(),
          personCode: tokenForm.personCode.trim(),
        };
        if (tokenForm.label.trim()) payload.label = tokenForm.label.trim();
        const d = Number(tokenForm.expiresInDays);
        if (Number.isFinite(d) && d > 0) payload.expiresInDays = d;
        if (tokenForm.appScopeIds.length) payload.appScopeIds = tokenForm.appScopeIds;
        const res = await fetch("/api/admin/tokens", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setTokenOnce(data.token || "");
        setTokenForm({ label: "", personName: "", personCode: "", expiresInDays: "", appScopeIds: [] });
        setOk("Token 创建成功（仅展示一次）。");
        message.success("Token 创建成功");
        if (typeof data.id === "string") {
          const appScopeIds = Array.isArray(data.appScopeIds) ? data.appScopeIds : [];
          setTokens((prev) => {
            const nextRow = {
              id: data.id,
              label: data.label ?? null,
              personName: data.personName ?? tokenForm.personName.trim(),
              personCode: data.personCode ?? tokenForm.personCode.trim(),
              revokedAt: data.revokedAt ?? null,
              expiresAt: data.expiresAt ?? null,
              createdAt: data.createdAt ?? new Date().toISOString(),
              appScopeIds,
            };
            return [nextRow, ...prev.filter((t) => t.id !== data.id)];
          });
        }
        const followups: Promise<void>[] = [fetchTokens()];
        if (loadedMenusRef.current.overview) {
          followups.push(fetchOverview());
        }
        if (loadedMenusRef.current.usage) {
          followups.push(fetchUsage(), fetchUsageRows(usageDateRange, usageTokenId || undefined));
        }
        if (loadedMenusRef.current.requests) {
          followups.push(fetchRequestRows(recordTokenId || undefined, requestDateRange, requestStatus));
        }
        await Promise.all(followups);
      });
    } finally {
      setCreatingToken(false);
    }
  }, [adminHeaders, assertAdminAuth, fetchOverview, fetchRequestRows, fetchTokens, fetchUsage, fetchUsageRows, message, recordTokenId, requestDateRange, requestStatus, tokenForm, usageDateRange, usageTokenId, withBusy]);

  const patchToken = useCallback(
    async (id: string, revoked: boolean) => {
      await withBusy(async () => {
        const res = await fetch(`/api/admin/tokens/${id}`, { method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ revoked }) });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setOk(revoked ? "Token 已吊销。" : "Token 已恢复。");
        message.success(revoked ? "已吊销 Token" : "已恢复 Token");
        const followups: Promise<void>[] = [fetchTokens()];
        if (loadedMenusRef.current.overview) {
          followups.push(fetchOverview());
        }
        if (loadedMenusRef.current.usage) {
          followups.push(fetchUsage(), fetchUsageRows(usageDateRange, usageTokenId || undefined));
        }
        if (loadedMenusRef.current.requests) {
          followups.push(fetchRequestRows(recordTokenId || undefined, requestDateRange, requestStatus));
        }
        await Promise.all(followups);
      });
    },
    [adminHeaders, assertAdminAuth, fetchOverview, fetchRequestRows, fetchTokens, fetchUsage, fetchUsageRows, message, recordTokenId, requestDateRange, requestStatus, usageDateRange, usageTokenId, withBusy]
  );

  const recreateToken = useCallback(
    async (id: string) => {
      await withBusy(async () => {
        setTokenOnce("");
        const res = await fetch(`/api/admin/tokens/${id}/recreate`, {
          method: "POST",
          headers: adminHeaders(),
        });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setTokenOnce(data.token || "");
        setOk("Token 已重新创建（仅展示一次）。");
        message.success("Token 已重新创建");
        const followups: Promise<void>[] = [fetchTokens()];
        if (loadedMenusRef.current.overview) {
          followups.push(fetchOverview());
        }
        if (loadedMenusRef.current.usage) {
          followups.push(fetchUsage(), fetchUsageRows(usageDateRange, usageTokenId || undefined));
        }
        if (loadedMenusRef.current.requests) {
          followups.push(fetchRequestRows(recordTokenId || undefined, requestDateRange, requestStatus));
        }
        await Promise.all(followups);
      });
    },
    [adminHeaders, assertAdminAuth, fetchOverview, fetchRequestRows, fetchTokens, fetchUsage, fetchUsageRows, message, recordTokenId, requestDateRange, requestStatus, usageDateRange, usageTokenId, withBusy]
  );

  const updateTokenScopes = useCallback(
    async (id: string, appScopeIds: string[]) => {
      await withBusy(async () => {
        const res = await fetch(`/api/admin/tokens/${id}`, {
          method: "PATCH",
          headers: adminHeaders(),
          body: JSON.stringify({ appScopeIds }),
        });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setOk("Token 应用权限已更新。");
        message.success("权限已更新");
        const saved = Array.isArray(data.appScopeIds) ? data.appScopeIds : appScopeIds;
        setTokens((prev) => prev.map((t) => (t.id === id ? { ...t, appScopeIds: saved } : t)));
        await fetchTokens();
      });
    },
    [adminHeaders, assertAdminAuth, fetchTokens, message, withBusy]
  );

  const rebuildClassIndex = useCallback(async () => {
    setRebuildingClassIndex(true);
    try {
      await withBusy(async () => {
        const res = await fetch("/api/admin/indexing/rebuild", { method: "POST", headers: adminHeaders() });
        assertAdminAuth(res);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const count = Number(data.count || 0);
        const harmonyCount = Number(data.harmonyCount || 0);
        setOk(`完整 indexing 已完成（Android ${count - harmonyCount} + 鸿蒙 ${harmonyCount} = ${count} 条）。`);
        message.success(`索引完成：共 ${count} 条（鸿蒙 ${harmonyCount}）`);
      });
    } finally {
      setRebuildingClassIndex(false);
    }
  }, [adminHeaders, assertAdminAuth, message, withBusy]);

  const logout = useCallback(() => {
    localStorage.removeItem("hm_admin_secret");
    router.replace("/admin/login");
  }, [router]);

  const refreshUsageRows = useCallback(async () => {
    await withBusy(async () => {
      await fetchUsageRows(usageDateRange, usageTokenId || undefined);
    });
  }, [fetchUsageRows, usageDateRange, usageTokenId, withBusy]);

  const refreshRequestRows = useCallback(async () => {
    await withBusy(async () => {
      await fetchRequestRows(recordTokenId || undefined, requestDateRange, requestStatus);
    });
  }, [fetchRequestRows, recordTokenId, requestDateRange, requestStatus, withBusy]);

  const refreshFeedbackRows = useCallback(async () => {
    await withBusy(async () => {
      await fetchFeedbackRows();
    });
  }, [fetchFeedbackRows, withBusy]);

  const refreshZcMcpAuditRows = useCallback(async () => {
    await withBusy(async () => {
      await fetchZcMcpAuditRows(zcMcpAuditDateRange, {
        consumer: zcMcpAuditConsumer,
        apiTokenId: zcMcpAuditTokenId || undefined,
        tool: zcMcpAuditTool || undefined,
        eventType: zcMcpAuditEventType || undefined,
        hit: zcMcpAuditHit || undefined,
      });
    });
  }, [
    fetchZcMcpAuditRows,
    zcMcpAuditConsumer,
    zcMcpAuditDateRange,
    zcMcpAuditEventType,
    zcMcpAuditHit,
    zcMcpAuditTokenId,
    zcMcpAuditTool,
    withBusy,
  ]);

  const refreshKnowledgeStats = useCallback(async () => {
    await withBusy(async () => {
      await fetchKnowledgeStats(knowledgeDays);
    });
  }, [fetchKnowledgeStats, knowledgeDays, withBusy]);

  const changeKnowledgeDays = useCallback(
    async (days: number) => {
      setKnowledgeDays(days);
      await withBusy(async () => {
        await fetchKnowledgeStats(days);
      });
    },
    [fetchKnowledgeStats, withBusy],
  );

  const refreshKbRoiStats = useCallback(async () => {
    await withBusy(async () => {
      await fetchKbRoiStats(kbRoiRange);
    });
  }, [fetchKbRoiStats, kbRoiRange, withBusy]);

  const changeKbRoiRange = useCallback(
    async (range: OverviewChartRange) => {
      setKbRoiRange(range);
      await withBusy(async () => {
        await fetchKbRoiStats(range);
      });
    },
    [fetchKbRoiStats, withBusy],
  );

  return {
    menuKey,
    setMenuKey,
    booting,
    menuLoading,
    busy,
    creatingToken,
    err,
    ok,
    clearFlash,
    tokens,
    appScopes,
    usage,
    usageRows,
    requestRows,
    feedbackRows,
    zcMcpAuditRows,
    zcMcpAuditTotal,
    zcMcpAuditByTool,
    zcMcpAuditByConsumer,
    zcMcpAuditDays,
    setZcMcpAuditDays,
    zcMcpAuditDateRange,
    setZcMcpAuditDateRange,
    zcMcpAuditConsumer,
    setZcMcpAuditConsumer,
    zcMcpAuditTokenId,
    setZcMcpAuditTokenId,
    zcMcpAuditTool,
    setZcMcpAuditTool,
    zcMcpAuditEventType,
    setZcMcpAuditEventType,
    zcMcpAuditHit,
    setZcMcpAuditHit,
    refreshZcMcpAuditRows,
    overviewChartRange,
    changeOverviewChartRange,
    overview,
    knowledgeStats,
    knowledgeDays,
    kbRoiStats,
    kbRoiRange,
    setKnowledgeDays,
    recordTokenId,
    setRecordTokenId,
    usageTokenId,
    setUsageTokenId,
    usageDateRange,
    setUsageDateRange,
    requestDateRange,
    setRequestDateRange,
    requestStatus,
    setRequestStatus,
    tokenForm,
    setTokenForm,
    tokenOnce,
    rebuildingClassIndex,
    usageSummary,
    fetchRequestRows,
    refreshUsageRows,
    refreshRequestRows,
    refreshFeedbackRows,
    refreshKnowledgeStats,
    changeKnowledgeDays,
    refreshKbRoiStats,
    changeKbRoiRange,
    repoSyncRuns,
    repoSyncRepos,
    repoSyncQueueDepth,
    refreshRepoSync: fetchRepoSync,
    triggerRepoSync,
    createToken,
    patchToken,
    recreateToken,
    updateTokenScopes,
    rebuildClassIndex,
    logout,
  };
}

