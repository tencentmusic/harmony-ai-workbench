import { REPORT_SIZE_UNIT, sizeText } from "./types";
import type { Explanation, PackageFile, PackageResult } from "./types";

export const DEFAULT_IMAGE_FILE_BYTES = 15 * 1024;
export const ASSESSMENT_VERSION = "growth-assessment-v1";
export interface GrowthRisk {
  id: string;
  title: string;
  evidence: string;
  suggestion: string;
  files: PackageFile[];
}

const format = (bytes: number) => sizeText(bytes, REPORT_SIZE_UNIT, 3);
const isImage = (file: PackageFile) =>
  /\.(png|jpe?g|webp|svg|gif|heic|heif|avif|bmp|ico)$/i.test(file.path);
const hasGrowth = (file: PackageFile) =>
  file.currentHash &&
  (file.status === "added" || file.status === "modified") &&
  (file.status === "added" ||
    file.delta > 0 ||
    file.currentRaw > file.baselineRaw);

// APP containers and their children have different compression boundaries. Inspect
// leaf files once; use only the uploaded artifact delta for the overall budget.
export function assessPackageGrowth(
  result: PackageResult,
  explanation: Explanation = {},
) {
  const files = [
    ...result.files.filter(
      (f) => !f.expanded && !(result.inner && /\.(hap|hsp)$/i.test(f.path)),
    ),
    ...(result.inner?.files || []),
  ];
  const growing = files.filter(hasGrowth);
  const rules = result.rules;
  const imageLimit =
    rules.imageFileBytes === undefined
      ? DEFAULT_IMAGE_FILE_BYTES
      : rules.imageFileBytes;
  const risks: GrowthRisk[] = [];
  const context: string[] = [];
  const add = (
    id: string,
    title: string,
    evidence: string,
    suggestion: string,
    files: PackageFile[] = [],
  ) => risks.push({ id, title, evidence, suggestion, files });

  if (rules.budgetBytes === null) {
    context.push("未设置整包增量预算，无法确认增量是否符合预算。");
  } else if (result.delta > rules.budgetBytes) {
    add(
      "budget",
      "整包增量超预算",
      `整包净增 ${format(result.delta)}，预算 ${format(rules.budgetBytes)}，超出 ${format(result.delta - rules.budgetBytes)}。`,
      "核对需求范围与增量来源，优化后复核或由负责人确认预算调整。",
    );
  }
  if (
    rules.growthPercent !== null &&
    result.growthPercent !== null &&
    result.growthPercent > rules.growthPercent
  ) {
    add(
      "growth",
      "整包增长比例超提醒值",
      `实际 ${result.growthPercent.toFixed(2)}%，提醒值 ${rules.growthPercent}%。`,
      "结合绝对增量和需求范围核查，比例本身不代表是否合理。",
    );
  }

  const oversizedImages = growing
    .filter(
      (f) => isImage(f) && imageLimit !== null && f.currentRaw > imageLimit,
    )
    .sort((a, b) => b.currentRaw - a.currentRaw || a.key.localeCompare(b.key));
  const oversizedImageKeys = new Set(oversizedImages.map((f) => f.key));
  for (const file of oversizedImages) {
    add(
      `image:${file.key}`,
      "单张图片偏大",
      `图片文件 ${format(file.baselineRaw)} → ${format(file.currentRaw)}，原始文件增量 ${format(file.currentRaw - file.baselineRaw)}，超过单图提醒值 ${format(imageLimit!)}。`,
      "核对实际展示尺寸；评估缩小分辨率、图片压缩、合适的 WebP/AVIF 格式或按需下载，保留画质和兼容性验证。",
      [file],
    );
  }
  for (const file of growing) {
    const large =
      rules.largeFileBytes !== null && file.current >= rules.largeFileBytes;
    const growth =
      rules.fileGrowthBytes !== null &&
      file.delta > 0 &&
      file.delta >= rules.fileGrowthBytes;
    if ((large || growth) && !oversizedImageKeys.has(file.key)) {
      add(
        `file:${file.key}`,
        growth ? "单文件增长达到提醒值" : "新增或增大的文件偏大",
        `所在归档条目压缩占用 ${format(file.baseline)} → ${format(file.current)}，增量 ${format(file.delta)}；${growth ? `增长提醒值 ${format(rules.fileGrowthBytes!)}` : `大小提醒值 ${format(rules.largeFileBytes!)}`}。`,
        "核对新增内容的用途、是否需内置，以及压缩、拆分或按需交付的可行性。",
        [file],
      );
    }
    if (
      file.architecture &&
      rules.targetArchitectures.length &&
      !rules.targetArchitectures.includes(file.architecture)
    ) {
      add(
        `arch:${file.key}`,
        "新增或增大的非目标架构文件",
        `实际架构 ${file.architecture}，目标架构 ${rules.targetArchitectures.join("、")}，所在归档压缩占用 ${format(file.current)}。`,
        "核查构建架构配置与设备兼容要求，确认该架构是否需要随包交付。",
        [file],
      );
    }
  }

  const previousCopies = new Map<string, number>();
  const currentCopies = new Map<string, PackageFile[]>();
  for (const file of files) {
    if (file.baselineHash && file.baselineRaw > 0)
      previousCopies.set(
        file.baselineHash,
        (previousCopies.get(file.baselineHash) || 0) + 1,
      );
    if (file.currentHash && file.currentRaw > 0) {
      const copies = currentCopies.get(file.currentHash) || [];
      copies.push(file);
      currentCopies.set(file.currentHash, copies);
    }
  }
  for (const [hash, copies] of currentCopies) {
    const before = previousCopies.get(hash) || 0;
    if (copies.length > Math.max(1, before)) {
      add(
        `duplicate:${copies[0].key}`,
        "新增相同内容副本",
        `相同内容由 ${before} 份变为 ${copies.length} 份，单份原始文件 ${format(copies[0].currentRaw)}。`,
        "确认模块共享与加载路径；重复内容不等于可以直接删除，也不代表等量的整包可节省空间。",
        copies,
      );
    }
  }

  const changedPaths = new Set(growing.map((f) => f.path));
  const outsideScope = new Set(
    result.findings
      .filter((f) => f.kind === "scope")
      .flatMap((f) => f.paths)
      .filter((p) => changedPaths.has(p)),
  );
  if (outsideScope.size) {
    add(
      "scope",
      "需求范围之外的增长",
      `${outsideScope.size} 个新增或增大的文件不在声明的需求范围内。`,
      "确认是否混入无关变更或需要补充需求影响范围。",
      growing.filter((f) => outsideScope.has(f.path)),
    );
  }

  const unconfirmed = growing.filter((file) => {
    const note = explanation.files?.[file.key];
    return (
      !note?.purpose?.trim() ||
      note.necessity === "unconfirmed" ||
      note.contentHash !== file.currentHash
    );
  }).length;
  if (unconfirmed)
    context.push(`${unconfirmed} 个新增或增大的文件尚未确认用途与必要性。`);
  if (result.completeness === "partial")
    context.push("分析不完整，仍有未展开内容需要核查。");
  const configurationKeys = [
    "mode",
    "architectures",
    "channel",
    "variant",
    "toolchain",
    "compression",
    "archiveCompression",
    "moduleCompression",
  ];
  const differences = configurationKeys.filter(
    (key) =>
      result.baselineMetadata[key] &&
      result.currentMetadata[key] &&
      result.baselineMetadata[key] !== result.currentMetadata[key],
  );
  if (differences.length)
    context.push(
      `构建配置存在差异（${differences.join("、")}），增量不能全部归因于业务改动。`,
    );
  if (!result.baselineMetadata.mode || !result.currentMetadata.mode)
    context.push("构建模式未知，需确认两份产物的 debug/release 配置一致。");

  const existingLargeImages = files.filter(
    (f) =>
      f.currentHash &&
      isImage(f) &&
      imageLimit !== null &&
      f.currentRaw > imageLimit &&
      !hasGrowth(f),
  ).length;
  const status = risks.length
    ? "attention"
    : context.length
      ? "needs_context"
      : "within_rules";
  return {
    version: ASSESSMENT_VERSION,
    status,
    title:
      status === "attention"
        ? "存在优化风险，建议核查后再确认合理性"
        : status === "needs_context"
          ? "暂未发现超限风险，仍需补充评估依据"
          : "当前规则内未发现增量风险，待人工确认",
    risks,
    context,
    imageLimit,
    usesSuggestedImageLimit: rules.imageFileBytes === undefined,
    existingLargeImages,
    unconfirmed,
    metric:
      "单图阈值按图片文件原始字节判断；其他文件阈值按所在归档条目压缩占用判断。APP 内层大小不作为整包增量，也不代表可直接节省的空间。",
  };
}
