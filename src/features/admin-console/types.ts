export type TokenRow = {
  id: string;
  label: string | null;
  personName: string;
  personCode: string;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  appScopeIds?: string[];
};

export type AppScopeRow = {
  id: string;
  label: string;
  prefixes: string[];
};

export type UsageRow = TokenRow & {
  stats: { total: number; done: number; failed: number; running: number; pending: number; lastAt: string | null };
};

export type RequestRow = {
  id: string;
  mode?: "convert" | "opencode";
  status: string;
  module: string;
  classFqn: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  model: { id: string; displayName: string | null; model: string | null };
  token: { id: string; personName: string; personCode: string; label: string | null } | null;
  errorPreview: string | null;
  userInput: string | null;
  userAttachments?: Array<{ path: string; name: string; mime: string; size: number; kind: "image" | "file" }>;
  modelOutput: string | null;
  outputImages?: Array<{ path: string; mime: string; alt?: string }>;
  outputPurgedAt: string | null;
};

export type FeedbackRow = {
  id: string;
  content: string;
  createdAt: string;
  userAgent: string | null;
  token: { id: string; personName: string; personCode: string; label: string | null } | null;
};

export type ZcMcpAuditRow = {
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

export type MenuKey = "overview" | "knowledge" | "kbRoi" | "repoSync" | "tokens" | "usage" | "requests" | "feedback" | "zcMcpAudit";

export type KnowledgeStatsState = {
  days: number;
  migrationDocCount: number;
  hotDocs: Array<{ docPath: string; count: number }>;
  coldDocs: Array<{ relPath: string }>;
  personStats: Array<{ person: string; pageViews: number; askAi: number }>;
};

export type KbRoiStatsState = {
  days: number;
  error: string | null;
  kpi: {
    total_turns: number;
    index_coverage_pct: number;
    call_reduction_pct: number | null;
    codegraph_backfill_turns: number;
    codegraph_backfill_denominator: number;
    codegraph_backfill_rate_pct: number | null;
    no_index_turns: number;
    with_index_turns: number;
    avg_raw_scan_no_index: number;
    avg_raw_scan_with_index: number;
  };
  byFeature: Array<{
    feature_id: string;
    context_served: number;
    match_hit: number;
    match_attempt: number;
    artifact_read: number;
    graph_query: number;
    graph_query_hit: number;
  }>;
  byDelivery: Array<{ delivery: string; bucket: string; count: number }>;
  cohort: Array<{
    cohort: string;
    kb_version: string;
    consumer: string;
    turns: number;
    avg_output_chars: number;
    avg_tool_calls: number;
    avg_kb_context_served: number;
    avg_codegraph_calls: number;
    avg_codegraph_hits: number;
    avg_raw_tool_calls: number;
    avg_artifact_reads: number;
    avg_duration_ms: number;
  }>;
  daily: Array<{
    day: string;
    context_served: number;
    graph_query: number;
    graph_query_hit: number;
    artifact_read: number;
    vector_query: number;
    raw_scan: number;
    tool_call: number;
    turns: number;
  }>;
  byToolFamily: Array<{ tool_family: string; retrieval_mode: string; count: number }>;
  byCodegraphTool: Array<{ tool_name: string; count: number; hit_count: number; avg_latency_ms: number; avg_results: number }>;
  retrievalFunnel: Array<{ level: string; retrieval_mode: string; events: number }>;
};

export type RepoSyncRepoRow = {
  id: string;
  label: string;
  path: string | null;
  source_id?: string;
  track_branches: string[];
  codegraph_projects: string[];
  class_index?: boolean;
  deploy_on_change?: { commands: string[][]; detached?: boolean };
};

export type RepoSyncRunRow = {
  id: string;
  repo_id: string;
  repo_path: string;
  branch: string;
  trigger: string;
  commit_sha: string | null;
  status: string;
  git_rev_before: string | null;
  git_rev_after: string | null;
  result?: unknown;
  error_message: string | null;
  created_at: string;
  deployment_id: string | null;
};

