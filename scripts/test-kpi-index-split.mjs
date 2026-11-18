#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { computeIndexCompareKpi } = await import(
  pathToFileURL(path.join(repoRoot, "src/lib/kb-telemetry-aggregates.ts")).href
);

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${label}`);
}

// 参考图：无 CodeGraph 39 次/轮 vs 有 3.2 次/轮 → ↓92%
const referenceTurns = [
  ...Array.from({ length: 10 }, () => ({ raw_tool_calls: 39, duration_ms: 10000, kb_context_served: 0, codegraph_hits: 0 })),
  ...Array.from({ length: 10 }, () => ({ raw_tool_calls: 3.2, duration_ms: 2000, kb_context_served: 1, codegraph_hits: 0 })),
];
const ref = computeIndexCompareKpi(referenceTurns);
assertEq(ref.call_reduction_pct, 92, "reference call reduction ~92%");
assertEq(ref.no_index_turns, 10, "reference no_index_turns");
assertEq(ref.with_index_turns, 10, "reference with_index_turns");

// L2 补位：3 轮无 L1 但有 L2 命中，共 5 轮无 L1
const backfillTurns = [
  { raw_tool_calls: 5, duration_ms: 5000, kb_context_served: 0, codegraph_hits: 1 },
  { raw_tool_calls: 4, duration_ms: 4000, kb_context_served: 0, codegraph_hits: 1 },
  { raw_tool_calls: 3, duration_ms: 3000, kb_context_served: 0, codegraph_hits: 1 },
  { raw_tool_calls: 0, duration_ms: 1000, kb_context_served: 0, codegraph_hits: 0 },
  { raw_tool_calls: 0, duration_ms: 800, kb_context_served: 0, codegraph_hits: 0 },
  { raw_tool_calls: 1, duration_ms: 1200, kb_context_served: 2, codegraph_hits: 0 },
];
const bf = computeIndexCompareKpi(backfillTurns);
assertEq(bf.codegraph_backfill_turns, 3, "backfill turns");
assertEq(bf.codegraph_backfill_denominator, 5, "backfill denominator");
assertEq(bf.codegraph_backfill_rate_pct, 60, "backfill rate 60%");
assertEq(bf.with_index_turns, 4, "with index includes L2 backfill");

// 无索引组裸扫为 0 → call_reduction_pct 应为 null
const zeroBaseline = [{ raw_tool_calls: 0, duration_ms: 1000, kb_context_served: 1, codegraph_hits: 0 }];
assertEq(computeIndexCompareKpi(zeroBaseline).call_reduction_pct, null, "zero baseline → null");

if (!process.exitCode) console.log("\nAll KPI index-split tests passed.");
