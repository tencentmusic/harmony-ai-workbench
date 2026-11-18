type QueryClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
};

const PROD_CONSUMER_SQL = `consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')`;

const FUNNEL_LEVEL_SQL = `COALESCE(
      NULLIF(json_extract(payload_json, '$.substitute_level'), ''),
      CASE json_extract(payload_json, '$.retrieval_mode')
        WHEN 'kb_pack' THEN 'L1'
        WHEN 'codegraph_index' THEN 'L2'
        WHEN 'vector_index' THEN 'L3'
        WHEN 'raw_scan' THEN 'L3'
        ELSE NULL
      END
    )`;

const DATA_DOMAIN_SQL = `CASE
      WHEN json_extract(payload_json, '$.retrieval_mode') = 'codegraph_index' THEN 'codegraph_index'
      WHEN json_extract(payload_json, '$.retrieval_mode') = 'vector_index' THEN 'vector_index'
      WHEN json_extract(payload_json, '$.retrieval_mode') = 'kb_pack' THEN 'kb_pack'
      WHEN NULLIF(json_extract(payload_json, '$.path_bucket'), '') IS NOT NULL THEN json_extract(payload_json, '$.path_bucket')
      WHEN NULLIF(json_extract(payload_json, '$.retrieval_mode'), '') IS NOT NULL THEN json_extract(payload_json, '$.retrieval_mode')
      ELSE 'other'
    END`;

const DELIVERY_CHANNEL_SQL = `COALESCE(
      NULLIF(json_extract(payload_json, '$.delivery'), ''),
      CASE
        WHEN json_extract(payload_json, '$.retrieval_mode') = 'kb_pack' THEN 'bff_prompt_inject'
        WHEN json_extract(payload_json, '$.retrieval_mode') = 'codegraph_index' THEN 'codegraph_mcp'
        WHEN event_type IN ('kb.tool_call', 'kb.artifact_read') THEN 'agent_native'
        ELSE '(none)'
      END
    )`;

const PROD_TS_SQL = `ts >= ? AND ${PROD_CONSUMER_SQL}`;

/** L2 有效命中：hit=true 或 result_count>0 且无 error（与 kb-telemetry lib 对齐） */
const GRAPH_QUERY_HIT_SQL = `(event_type = 'kb.graph_query' AND (
  json_extract(payload_json, '$.hit') IN ('true', '1')
  OR CAST(json_extract(payload_json, '$.result_count') AS INTEGER) > 0
) AND COALESCE(json_extract(payload_json, '$.error'), '') = '')`;

/** 无 trace 的 opencode-mcp graph 事件（按 turn 时间窗归因到 session.turn_closed） */
const ORPHAN_GRAPH_QUERY_HIT_SQL = `(g.event_type = 'kb.graph_query' AND (
  json_extract(g.payload_json, '$.hit') IN ('true', '1')
  OR CAST(json_extract(g.payload_json, '$.result_count') AS INTEGER) > 0
) AND COALESCE(json_extract(g.payload_json, '$.error'), '') = '')`;

function effectiveCohort(row: Record<string, unknown>) {
  const hasKb = Number(row.kb_context_served || 0) > 0;
  const hasCg = Number(row.codegraph_hits || 0) > 0;
  const hasRaw = Number(row.raw_tool_calls || 0) > 0;
  if (hasKb && !hasCg && !hasRaw) return "kb_only";
  if (hasKb && hasCg) return "kb_plus_codegraph";
  if (!hasKb && hasCg) return "codegraph_only";
  if (hasRaw && !hasKb && !hasCg) return "raw_scan";
  if (hasKb && hasRaw && !hasCg) return "kb_mixed";
  return "kb_off";
}

function buildCohortRows(turnRows: Record<string, unknown>[]) {
  const groups = new Map<
    string,
    {
      cohort: string;
      kb_version: string;
      consumer: string;
      turns: number;
      sum_output: number;
      sum_tool_calls: number;
      sum_kb: number;
      sum_cg_calls: number;
      sum_cg_hits: number;
      sum_raw: number;
      sum_artifact: number;
      sum_duration: number;
    }
  >();

  for (const row of turnRows) {
    const cohort = effectiveCohort(row);
    const kbVersion = String(row.kb_version || "unknown");
    const consumer = String(row.consumer || "(none)");
    const key = `${cohort}::${kbVersion}::${consumer}`;
    if (!groups.has(key)) {
      groups.set(key, {
        cohort,
        kb_version: kbVersion,
        consumer,
        turns: 0,
        sum_output: 0,
        sum_tool_calls: 0,
        sum_kb: 0,
        sum_cg_calls: 0,
        sum_cg_hits: 0,
        sum_raw: 0,
        sum_artifact: 0,
        sum_duration: 0,
      });
    }
    const g = groups.get(key)!;
    g.turns += 1;
    g.sum_output += Number(row.output_chars || 0);
    g.sum_tool_calls += Number(row.tool_calls || 0);
    g.sum_kb += Number(row.kb_context_served || 0);
    g.sum_cg_calls += Number(row.codegraph_calls || 0);
    g.sum_cg_hits += Number(row.codegraph_hits || 0);
    g.sum_raw += Number(row.raw_tool_calls || 0);
    g.sum_artifact += Number(row.artifact_reads || 0);
    g.sum_duration += Number(row.duration_ms || 0);
  }

  return [...groups.values()]
    .map((g) => ({
      cohort: g.cohort,
      kb_version: g.kb_version,
      consumer: g.consumer,
      turns: g.turns,
      avg_output_chars: g.turns ? Math.round(g.sum_output / g.turns) : 0,
      avg_tool_calls: g.turns ? Math.round((g.sum_tool_calls / g.turns) * 100) / 100 : 0,
      avg_kb_context_served: g.turns ? Math.round((g.sum_kb / g.turns) * 100) / 100 : 0,
      avg_codegraph_calls: g.turns ? Math.round((g.sum_cg_calls / g.turns) * 100) / 100 : 0,
      avg_codegraph_hits: g.turns ? Math.round((g.sum_cg_hits / g.turns) * 100) / 100 : 0,
      avg_raw_tool_calls: g.turns ? Math.round((g.sum_raw / g.turns) * 100) / 100 : 0,
      avg_artifact_reads: g.turns ? Math.round((g.sum_artifact / g.turns) * 100) / 100 : 0,
      avg_duration_ms: g.turns ? Math.round(g.sum_duration / g.turns) : 0,
    }))
    .sort((a, b) => b.turns - a.turns);
}

function weightedAvg(rows: Record<string, unknown>[], field: string) {
  const totalTurns = rows.reduce((s, r) => s + Number(r.turns || 0), 0);
  if (!totalTurns) return 0;
  return rows.reduce((s, r) => s + Number(r[field] || 0) * Number(r.turns || 0), 0) / totalTurns;
}

function roundPct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.max(-100, Math.min(100, Math.round((numerator / denominator) * 100)));
}

/** L1 工台注入或 L2 有效命中（与 index_coverage_pct 同一分轮口径） */
export function turnHasIndexHit(row: Record<string, unknown>) {
  return Number(row.kb_context_served || 0) > 0 || Number(row.codegraph_hits || 0) > 0;
}

function avgField(rows: Record<string, unknown>[], field: string) {
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + Number(r[field] || 0), 0) / rows.length;
}

/** 无/有索引命中两组对比：裸扫描轮均次数（参考 CodeGraph ROI 表） */
export function computeIndexCompareKpi(turnRows: Record<string, unknown>[]) {
  const noIndexTurns = turnRows.filter((r) => !turnHasIndexHit(r));
  const withIndexTurns = turnRows.filter((r) => turnHasIndexHit(r));

  const avgRawNoIndex = avgField(noIndexTurns, "raw_tool_calls");
  const avgRawWithIndex = avgField(withIndexTurns, "raw_tool_calls");

  const noL1Turns = turnRows.filter((r) => Number(r.kb_context_served || 0) === 0);
  const backfillTurns = noL1Turns.filter((r) => Number(r.codegraph_hits || 0) > 0).length;

  let callReductionPct: number | null = null;
  if (avgRawNoIndex > 0 && withIndexTurns.length > 0) {
    callReductionPct = roundPct(avgRawNoIndex - avgRawWithIndex, avgRawNoIndex);
  }

  const backfillRatePct = noL1Turns.length ? roundPct(backfillTurns, noL1Turns.length) : null;

  return {
    no_index_turns: noIndexTurns.length,
    with_index_turns: withIndexTurns.length,
    avg_raw_scan_no_index: Math.round(avgRawNoIndex * 100) / 100,
    avg_raw_scan_with_index: Math.round(avgRawWithIndex * 100) / 100,
    call_reduction_pct: callReductionPct,
    codegraph_backfill_turns: backfillTurns,
    codegraph_backfill_denominator: noL1Turns.length,
    codegraph_backfill_rate_pct: backfillRatePct,
  };
}

export type StatsSummaryWindow = {
  since: string;
  until?: string;
  days?: number;
  range?: string;
};

export async function buildStatsSummary(client: QueryClient, daysOrWindow: number | StatsSummaryWindow = 7) {
  const window: StatsSummaryWindow =
    typeof daysOrWindow === "number"
      ? { since: new Date(Date.now() - daysOrWindow * 86400000).toISOString(), days: daysOrWindow }
      : daysOrWindow;
  const since = window.since;
  const until = window.until;
  const days = window.days ?? 0;
  const filterSql = until ? `ts >= ? AND ts <= ? AND ${PROD_CONSUMER_SQL}` : PROD_TS_SQL;
  const tsParams = until ? [since, until] : [since];
  const boundSql = until ? `ts >= ? AND ts <= ?` : `ts >= ?`;

  const totals = await client.query(
    `
    SELECT event_type, consumer, CAST(COUNT(*) AS INTEGER) AS count
    FROM kb_telemetry_events WHERE ${filterSql}
    GROUP BY 1, 2 ORDER BY count DESC
    `,
    tsParams,
  );

  const byFeature = await client.query(
    `
    SELECT
      COALESCE(feature_id, json_extract(payload_json, '$.feature_id'), '(unknown)') AS feature_id,
      SUM(CASE WHEN event_type = 'kb.context_served' THEN 1 ELSE 0 END) AS context_served,
      SUM(CASE WHEN event_type = 'kb.match_attempt' AND json_extract(payload_json, '$.hit') = 'true' THEN 1 ELSE 0 END) AS match_hit,
      SUM(CASE WHEN event_type = 'kb.match_attempt' THEN 1 ELSE 0 END) AS match_attempt,
      SUM(CASE WHEN event_type = 'kb.artifact_read' THEN 1 ELSE 0 END) AS artifact_read,
      SUM(CASE WHEN event_type = 'kb.graph_query' THEN 1 ELSE 0 END) AS graph_query,
      SUM(CASE WHEN ${GRAPH_QUERY_HIT_SQL} THEN 1 ELSE 0 END) AS graph_query_hit
    FROM kb_telemetry_events WHERE ${filterSql}
      AND COALESCE(feature_id, json_extract(payload_json, '$.feature_id')) IS NOT NULL
    GROUP BY 1 ORDER BY context_served DESC, graph_query_hit DESC LIMIT 30
    `,
    tsParams,
  );

  const byDelivery = await client.query(
    `
    SELECT
      ${DELIVERY_CHANNEL_SQL} AS delivery,
      ${DATA_DOMAIN_SQL} AS bucket,
      CAST(COUNT(*) AS INTEGER) AS count
    FROM kb_telemetry_events
    WHERE ${filterSql} AND event_type IN ('kb.context_served', 'kb.artifact_read', 'kb.graph_query')
    GROUP BY 1, 2 ORDER BY count DESC LIMIT 40
    `,
    tsParams,
  );

  const turnToolStats = await client.query(
    `
    SELECT
      tc.trace_id,
      tc.turn_id,
      tc.kb_version,
      tc.consumer,
      COALESCE(CAST(json_extract(tc.payload_json, '$.kb_context_served') AS INTEGER), 0) AS kb_context_served,
      COALESCE(CAST(json_extract(tc.payload_json, '$.output_chars') AS INTEGER), 0) AS output_chars,
      COALESCE(CAST(json_extract(tc.payload_json, '$.duration_ms') AS INTEGER), 0) AS duration_ms,
      COALESCE(CAST(json_extract(tc.payload_json, '$.artifact_reads') AS INTEGER), 0) AS artifact_reads,
      COALESCE(t.raw_tool_calls, 0) AS raw_tool_calls,
      COALESCE(t.tool_calls, 0) + COALESCE(o.codegraph_calls, 0) AS tool_calls,
      COALESCE(t.codegraph_calls, 0) + COALESCE(o.codegraph_calls, 0) AS codegraph_calls,
      COALESCE(t.codegraph_hits, 0) + COALESCE(o.codegraph_hits, 0) AS codegraph_hits
    FROM kb_telemetry_events tc
    LEFT JOIN (
      SELECT
        trace_id,
        turn_id,
        SUM(CASE
          WHEN event_type = 'kb.tool_call'
            AND COALESCE(json_extract(payload_json, '$.retrieval_mode'), '') = 'raw_scan'
          THEN 1 ELSE 0 END) AS raw_tool_calls,
        SUM(CASE
          WHEN event_type IN ('kb.tool_call', 'kb.graph_query')
          THEN 1 ELSE 0 END) AS tool_calls,
        SUM(CASE
          WHEN event_type = 'kb.graph_query'
          THEN 1 ELSE 0 END) AS codegraph_calls,
        SUM(CASE
          WHEN ${GRAPH_QUERY_HIT_SQL}
          THEN 1 ELSE 0 END) AS codegraph_hits
      FROM kb_telemetry_events
      WHERE ${boundSql}
        AND trace_id IS NOT NULL
        AND turn_id IS NOT NULL
        AND event_type IN ('kb.tool_call', 'kb.graph_query', 'kb.vector_query')
        AND consumer NOT IN ('test', 'benchmark')
      GROUP BY trace_id, turn_id
    ) t ON tc.trace_id = t.trace_id AND tc.turn_id = t.turn_id
    LEFT JOIN (
      SELECT
        tc2.trace_id,
        tc2.turn_id,
        CAST(SUM(CASE WHEN g.event_type = 'kb.graph_query' THEN 1 ELSE 0 END) AS INTEGER) AS codegraph_calls,
        CAST(SUM(CASE WHEN ${ORPHAN_GRAPH_QUERY_HIT_SQL} THEN 1 ELSE 0 END) AS INTEGER) AS codegraph_hits
      FROM kb_telemetry_events tc2
      JOIN kb_telemetry_events g ON
        g.event_type = 'kb.graph_query'
        AND g.consumer = 'opencode-mcp'
        AND (g.trace_id IS NULL OR g.trace_id = '')
        AND julianday(g.ts) <= julianday(tc2.ts)
        AND (julianday(tc2.ts) - julianday(g.ts)) * 86400000.0
          <= COALESCE(CAST(json_extract(tc2.payload_json, '$.duration_ms') AS REAL), 600000) + 120000
      WHERE ${boundSql.replaceAll("ts ", "tc2.ts ")}
        AND tc2.event_type = 'session.turn_closed'
        AND tc2.consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')
      GROUP BY tc2.trace_id, tc2.turn_id
    ) o ON tc.trace_id = o.trace_id AND tc.turn_id = o.turn_id
    WHERE ${boundSql.replaceAll("ts ", "tc.ts ")}
      AND tc.event_type = 'session.turn_closed'
      AND tc.consumer NOT IN ('test', 'benchmark', 'mcp-direct', 'ingest')
    `,
    [...tsParams, ...tsParams, ...tsParams],
  );

  const turnRows = turnToolStats.rows;
  const cohortRows = buildCohortRows(turnRows);

  const daily = await client.query(
    `
    SELECT
      strftime('%Y-%m-%d', datetime(ts, '+8 hours')) AS day,
      SUM(CASE WHEN event_type = 'kb.context_served' AND COALESCE(json_extract(payload_json, '$.retrieval_mode'), 'kb_pack') = 'kb_pack' THEN 1 ELSE 0 END) AS context_served,
      SUM(CASE WHEN event_type = 'kb.graph_query' THEN 1 ELSE 0 END) AS graph_query,
      SUM(CASE WHEN ${GRAPH_QUERY_HIT_SQL} THEN 1 ELSE 0 END) AS graph_query_hit,
      SUM(CASE WHEN event_type = 'kb.artifact_read' THEN 1 ELSE 0 END) AS artifact_read,
      SUM(CASE
        WHEN event_type = 'kb.tool_call'
          AND COALESCE(json_extract(payload_json, '$.retrieval_mode'), 'raw_scan') = 'raw_scan'
        THEN 1 ELSE 0 END) AS raw_scan,
      SUM(CASE WHEN event_type = 'kb.tool_call' THEN 1 ELSE 0 END) AS tool_call,
      SUM(CASE WHEN event_type = 'session.turn_closed' THEN 1 ELSE 0 END) AS turns
    FROM kb_telemetry_events WHERE ${filterSql}
    GROUP BY 1 ORDER BY 1 ASC
    `,
    tsParams,
  );

  const byToolFamily = await client.query(
    `
    SELECT
      COALESCE(json_extract(payload_json, '$.tool_family'), '(none)') AS tool_family,
      COALESCE(json_extract(payload_json, '$.retrieval_mode'), '(none)') AS retrieval_mode,
      CAST(COUNT(*) AS INTEGER) AS count
    FROM kb_telemetry_events
    WHERE ${filterSql} AND event_type IN ('kb.tool_call', 'kb.graph_query', 'kb.context_served')
    GROUP BY 1, 2 ORDER BY count DESC
    `,
    tsParams,
  );

  const byCodegraphTool = await client.query(
    `
    SELECT
      COALESCE(json_extract(payload_json, '$.tool_name'), '(none)') AS tool_name,
      CAST(COUNT(*) AS INTEGER) AS count,
      SUM(CASE WHEN ${GRAPH_QUERY_HIT_SQL} THEN 1 ELSE 0 END) AS hit_count,
      CAST(ROUND(AVG(CAST(json_extract(payload_json, '$.latency_ms') AS REAL))) AS INTEGER) AS avg_latency_ms,
      ROUND(AVG(CAST(json_extract(payload_json, '$.result_count') AS REAL)), 1) AS avg_results
    FROM kb_telemetry_events
    WHERE ${filterSql} AND event_type = 'kb.graph_query'
      AND COALESCE(json_extract(payload_json, '$.tool_name'), '') NOT LIKE 'harmony-kb%'
      AND COALESCE(json_extract(payload_json, '$.tool_name'), '') NOT LIKE 'android-harmony-kb%'
    GROUP BY 1 ORDER BY count DESC
    `,
    tsParams,
  );

  const retrievalFunnel = await client.query(
    `
    SELECT
      level,
      retrieval_mode,
      CAST(COUNT(*) AS INTEGER) AS events
    FROM (
      SELECT
        ${FUNNEL_LEVEL_SQL} AS level,
        COALESCE(NULLIF(json_extract(payload_json, '$.retrieval_mode'), ''), '(none)') AS retrieval_mode
      FROM kb_telemetry_events
      WHERE ${filterSql}
        AND event_type IN ('kb.context_served', 'kb.graph_query', 'kb.tool_call')
        AND NOT (
          event_type = 'kb.context_served'
          AND json_extract(payload_json, '$.retrieval_mode') = 'codegraph_index'
        )
    ) funnel_rows
    WHERE level IS NOT NULL
    GROUP BY 1, 2 ORDER BY level ASC
    `,
    tsParams,
  );

  const indexCompare = computeIndexCompareKpi(turnRows);
  const totalTurns = turnRows.length;
  const indexedTurns = turnRows.filter((r) => turnHasIndexHit(r)).length;

  const kpi = {
    total_turns: totalTurns,
    index_coverage_pct: totalTurns ? Math.round((indexedTurns / totalTurns) * 100) : 0,
    call_reduction_pct: indexCompare.call_reduction_pct,
    codegraph_backfill_turns: indexCompare.codegraph_backfill_turns,
    codegraph_backfill_denominator: indexCompare.codegraph_backfill_denominator,
    codegraph_backfill_rate_pct: indexCompare.codegraph_backfill_rate_pct,
    no_index_turns: indexCompare.no_index_turns,
    with_index_turns: indexCompare.with_index_turns,
    avg_raw_scan_no_index: indexCompare.avg_raw_scan_no_index,
    avg_raw_scan_with_index: indexCompare.avg_raw_scan_with_index,
  };

  return {
    days,
    range: window.range || null,
    since,
    until: until || null,
    schema_version: "1.4",
    kpi,
    totals: totals.rows,
    byFeature: byFeature.rows,
    byDelivery: byDelivery.rows,
    cohort: cohortRows,
    daily: daily.rows,
    byToolFamily: byToolFamily.rows,
    byCodegraphTool: byCodegraphTool.rows,
    retrievalFunnel: retrievalFunnel.rows,
  };
}
