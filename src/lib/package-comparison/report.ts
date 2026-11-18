import {
  FILE_LABELS,
  REVIEW_LABELS,
  SCENES,
  REPORT_SIZE_UNIT,
  sizeText,
} from "./types";
import type { Comparison, PackageResult } from "./types";
import { assessPackageGrowth } from "./assessment";
const safe = (v: unknown) =>
  String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[|<>`]/g, (c) => `&#${c.charCodeAt(0)};`);
function table(headers: string[], rows: unknown[][]) {
  return [
    headers.map(safe).join(" | "),
    headers.map(() => "---").join(" | "),
    ...rows.map((r) => r.map(safe).join(" | ")),
  ].join("\n");
}
export function markdownReport(task: Comparison, result: PackageResult) {
  const unit = REPORT_SIZE_UNIT,
    format = (n: number | null) => sizeText(n, unit, 3);
  const run = task.runs[0];
  const assessment = assessPackageGrowth(result, task.explanation);
  const stats = (rows: PackageResult["modules"]) =>
    table(
      ["名称", "状态", "基准", "当前", "净增量"],
      rows.map((r) => [
        r.name,
        FILE_LABELS[r.status],
        format(r.baseline),
        format(r.current),
        format(r.delta),
      ]),
    );
  const sections = [
    `# ${safe(task.title)}`,
    `项目：${safe(task.projectId)} · ${safe(SCENES[task.input.scene as keyof typeof SCENES])} · 负责人：${safe(task.input.owner)}`,
    `关联需求：${safe(task.input.requirement || "未填写")}\n\n需求范围：${safe(task.input.scope.join("、") || "未声明")}`,
    `基准产物：${safe(task.baseline?.name)}（${task.baselineId}）\n\n当前产物：${safe(task.current?.name)}（${task.currentId}）`,
    `分析版本：${run.version} / ${safe(result.algorithm)} · 说明版本：${task.explanationVersion} · 审核：${REVIEW_LABELS[task.reviewStatus]}`,
    `单位：${unit}（1 ${unit} = 1,024 字节）。${result.metric}。不提供预估下载或安装大小。`,
    `分析完整性：${result.completeness === "partial" ? "部分完成" : "完整（声明的能力范围）"}。原始包：${task.baseline?.purgedAt || task.current?.purgedAt ? "已清理，复算受限" : "保留中，受项目保留策略约束"}`,
    "## 基本信息与可比性",
    table(
      ["字段", "基准", "当前"],
      [
        ...new Set([
          ...Object.keys(result.baselineMetadata),
          ...Object.keys(result.currentMetadata),
        ]),
      ].map((k) => [
        k,
        result.baselineMetadata[k] || "未知",
        result.currentMetadata[k] || "未知",
      ]),
    ),
    `负责人可比性说明：${safe(task.input.compatibilityNote || "未填写")}`,
    "## 体积总览",
    table(
      ["指标", "数值"],
      [
        ["基准", format(result.baseline)],
        ["当前", format(result.current)],
        ["净增量", format(result.delta)],
        [
          "增长比例",
          result.growthPercent === null
            ? "新增"
            : `${result.growthPercent.toFixed(2)}%`,
        ],
        ["文件正向增长合计", format(result.positive)],
        ["文件缩小/删除合计", format(result.negative)],
        ["结构开销变化", format(result.overheadDelta)],
        [
          "增量预算",
          result.rules.budgetBytes === null
            ? "未设置"
            : format(result.rules.budgetBytes),
        ],
        [
          "预算剩余（负数为超出）",
          result.budgetRemaining === null
            ? "未设置"
            : format(result.budgetRemaining),
        ],
      ],
    ),
    "新增文件大小不等于整个产物净增量。正向增长 + 缩小/删除 + 结构开销变化 = 净增量。",
    "## 增量合理性评估",
    `${assessment.title}。辅助评估，不自动改变审核结论。评估版本：${assessment.version}。`,
    `单图提醒值：${assessment.imageLimit === null ? "已关闭" : format(assessment.imageLimit)}${assessment.usesSuggestedImageLimit ? "（参考值，历史任务未配置）" : ""}。${assessment.metric}`,
    table(
      ["风险", "依据", "文件", "建议核查"],
      assessment.risks.map((risk) => [
        risk.title,
        risk.evidence,
        risk.files.map((f) => f.path).join("；"),
        risk.suggestion,
      ]),
    ),
    ...assessment.context.map((text) => `- ${safe(text)}`),
    `另有 ${assessment.existingLargeImages} 张未新增或增大的存量图片超过提醒值，未计入本次增量风险。`,
    "## 模块",
    stats(result.modules),
    "## 文件类型",
    stats(result.categories),
    "## 业务分组 × 文件类型",
    stats(result.businessTypes),
    `结构开销：${format(result.overheadBaseline)} → ${format(result.overheadCurrent)}，净增 ${format(result.overheadDelta)}。模块/分类合计 + 结构开销与主指标按字节对账。`,
    "## 关键文件",
    table(
      [
        "路径",
        "状态",
        "基准压缩占用",
        "当前压缩占用",
        "增量",
        "用途",
        "必要性",
        "已做优化",
        "保留原因",
      ],
      result.files
        .filter((f) => f.status !== "unchanged")
        .slice(0, 200)
        .map((f) => {
          const note = task.explanation.files?.[f.key];
          return [
            f.path,
            FILE_LABELS[f.status],
            format(f.baseline),
            format(f.current),
            format(f.delta),
            note?.purpose || "未填写",
            note?.necessity === "necessary"
              ? "必要"
              : note?.necessity === "optimizable"
                ? "可优化"
                : "待确认",
            note?.optimization || "",
            note?.reason || "",
          ];
        }),
    ),
    "关键文件最多展示200条，完整变更清单见 CSV（包含有改动的原生库）。",
    ...(result.inner
      ? [
          "## HAP/HSP 内部统计（独立口径）",
          result.inner.metric,
          `模块包长度合计：${format(result.inner.baseline)} → ${format(result.inner.current)}；净增量：${format(result.inner.delta)}。内部条目正向增长 ${format(result.inner.positive)} + 缩小/删除 ${format(result.inner.negative)} + 结构开销变化 ${format(result.inner.overheadDelta)} = 内部净增量。`,
          `内部结构开销：${format(result.inner.overheadBaseline)} → ${format(result.inner.overheadCurrent)}。以下各表加内部结构开销与模块包长度合计对账，不与 APP 大小相加。`,
          "### 内部模块",
          stats(result.inner.modules),
          "### 内部文件类型",
          stats(result.inner.categories),
          "### 内部业务分组 × 文件类型",
          stats(result.inner.businessTypes),
          "### 内部关键文件（最多200条）",
          table(
            [
              "模块",
              "路径",
              "状态",
              "基准压缩占用",
              "当前压缩占用",
              "净增量",
              "用途",
              "必要性",
              "已做优化",
              "保留原因",
            ],
            result.inner.files
              .filter((f) => f.status !== "unchanged")
              .slice(0, 200)
              .map((f) => {
                const n = task.explanation.files?.[f.key];
                return [
                  f.module,
                  f.path,
                  FILE_LABELS[f.status],
                  format(f.baseline),
                  format(f.current),
                  format(f.delta),
                  n?.purpose || "未填写",
                  n?.necessity === "necessary"
                    ? "必要"
                    : n?.necessity === "optimizable"
                      ? "可优化"
                      : "待确认",
                  n?.optimization || "",
                  n?.reason || "",
                ];
              }),
          ),
        ]
      : []),
    "## 检查提示",
    ...result.findings.map(
      (f) =>
        `- ${safe(f.message)}${f.paths.length ? `：${f.paths.map(safe).join("、")}` : ""}`,
    ),
    "优化提示不等于删除建议，潜在重复占用不代表实际可节省大小。",
    "## 人工说明",
    `增量来源与用途：${safe(task.explanation.summary || "待补充")}\n\n已做优化：${safe(task.explanation.optimization || "待补充")}\n\n保留原因：${safe(task.explanation.retentionReason || "待补充")}`,
    "## 审核历史",
    table(
      ["时间", "审核人", "分析版本", "说明版本", "状态", "原因"],
      (task.reviews || []).map((r) => [
        r.createdAt,
        r.actorName,
        r.analysisVersion,
        r.explanationVersion,
        REVIEW_LABELS[r.status],
        r.reason,
      ]),
    ),
    "## 统计与规则快照",
    `能力：${safe(JSON.stringify(result.capabilities))}`,
    `规则（按数组优先匹配，分类互斥）：\n\n\`\`\`json\n${JSON.stringify(result.rules, null, 2)}\n\`\`\``,
  ];
  return sections.join("\n\n") + "\n";
}
export function csvReport(task: Comparison, result: PackageResult) {
  const fileRisks = new Map<
    string,
    ReturnType<typeof assessPackageGrowth>["risks"]
  >();
  for (const risk of assessPackageGrowth(result, task.explanation).risks)
    for (const file of risk.files)
      fileRisks.set(file.key, [...(fileRisks.get(file.key) || []), risk]);
  const cell = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(s) && typeof v !== "number") s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = [
    "统计范围（不同范围不可相加）",
    "模块",
    "业务",
    "类型",
    "路径",
    "文件名",
    "架构",
    "状态",
    "基准压缩字节",
    "当前压缩字节",
    "净增字节",
    "基准解压字节",
    "当前解压字节",
    "用途",
    "必要性",
    "已做优化",
    "保留原因",
    "基准压缩占用(" + REPORT_SIZE_UNIT + ")",
    "当前压缩占用(" + REPORT_SIZE_UNIT + ")",
    "净增量(" + REPORT_SIZE_UNIT + ")",
    "增量评估提示",
    "建议核查",
  ];
  const scopedFiles = [
    ...result.files.map((f) => ({ f, scope: "上传产物外层 ZIP" })),
    ...(result.inner?.files || []).map((f) => ({
      f,
      scope: "HAP/HSP 内部 ZIP，非 APP 最终贡献",
    })),
  ];
  const rows = scopedFiles
    .filter(({ f }) => f.status !== "unchanged")
    .map(({ f, scope }) => {
      const n = task.explanation.files?.[f.key];
      return [
        scope,
        f.module,
        f.group,
        f.category,
        f.path,
        f.name,
        f.architecture || "不适用/未知",
        FILE_LABELS[f.status],
        f.baseline,
        f.current,
        f.delta,
        f.baselineRaw,
        f.currentRaw,
        n?.purpose || "",
        n?.necessity === "necessary"
          ? "必要"
          : n?.necessity === "optimizable"
            ? "可优化"
            : "待确认",
        n?.optimization || "",
        n?.reason || "",
        sizeText(f.baseline, REPORT_SIZE_UNIT, 3),
        sizeText(f.current, REPORT_SIZE_UNIT, 3),
        sizeText(f.delta, REPORT_SIZE_UNIT, 3),
        (fileRisks.get(f.key) || [])
          .map((risk) => `${risk.title}：${risk.evidence}`)
          .join("；"),
        (fileRisks.get(f.key) || []).map((risk) => risk.suggestion).join("；"),
      ];
    });
  return (
    "\ufeff" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")
  );
}
