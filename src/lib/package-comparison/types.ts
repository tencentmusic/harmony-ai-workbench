export type SizeUnit = "MB" | "MiB";
export const REPORT_SIZE_UNIT = "KB";
export type FileStatus = "added" | "removed" | "modified" | "unchanged";
export type ReviewStatus =
  | "draft"
  | "pending"
  | "needs_info"
  | "approved"
  | "rejected";
export type Metadata = Record<string, string>;
export interface MappingRule {
  prefix: string;
  name: string;
  owner?: string;
}
export interface CategoryRule {
  category: string;
  extensions?: string[];
  prefix?: string;
}
export interface PackageRules {
  version: string;
  unit: SizeUnit;
  targetArchitectures: string[];
  budgetBytes: number | null;
  growthPercent: number | null;
  largeFileBytes: number | null;
  fileGrowthBytes: number | null;
  imageFileBytes?: number | null;
  groups: MappingRule[];
  modules: MappingRule[];
  categories: CategoryRule[];
}
export interface PackageProject {
  id: string;
  label: string;
  platform: "HarmonyOS";
  formats: string[];
  rules: PackageRules;
}
export interface Artifact {
  id: string;
  projectId: string;
  name: string;
  size: number;
  metadata: Metadata;
  createdAt: string;
  purgedAt: string | null;
}
export interface PackageInput {
  title: string;
  projectId: string;
  scene: string;
  requirement: string;
  owner: string;
  scope: string[];
  rules: PackageRules;
  baselineMetadata: Metadata;
  currentMetadata: Metadata;
  compatibilityNote: string;
}
export interface PackageFile {
  expanded?: boolean;
  key: string;
  module: string;
  path: string;
  name: string;
  category: string;
  group: string;
  owner: string;
  architecture: string;
  status: FileStatus;
  baseline: number;
  current: number;
  delta: number;
  baselineRaw: number;
  currentRaw: number;
  baselineHash: string | null;
  currentHash: string | null;
}
export interface SizeRow {
  name: string;
  baseline: number;
  current: number;
  delta: number;
  status: FileStatus;
}
export interface Finding {
  kind: string;
  message: string;
  paths: string[];
}
export interface PackageResult {
  inner?: PackageResult;
  algorithm: string;
  rules: PackageRules;
  metric: string;
  capabilities: Record<string, string>;
  completeness: "complete" | "partial";
  baseline: number;
  current: number;
  delta: number;
  growthPercent: number | null;
  positive: number;
  negative: number;
  overheadBaseline: number;
  overheadCurrent: number;
  overheadDelta: number;
  budgetRemaining: number | null;
  modules: SizeRow[];
  categories: SizeRow[];
  businessTypes: SizeRow[];
  files: PackageFile[];
  findings: Finding[];
  baselineMetadata: Metadata;
  currentMetadata: Metadata;
}
export interface FileExplanation {
  purpose: string;
  necessity: "necessary" | "optimizable" | "unconfirmed";
  optimization: string;
  reason: string;
  contentHash: string | null;
}
export interface Explanation {
  summary?: string;
  optimization?: string;
  retentionReason?: string;
  files?: Record<string, FileExplanation>;
}
export interface Analysis {
  id: string;
  version: number;
  status: string;
  progress: number;
  error: string | null;
  result: PackageResult | null;
  createdAt: string;
}
export interface Review {
  id: string;
  analysisVersion: number;
  explanationVersion: number;
  status: ReviewStatus;
  reason: string;
  actorName: string;
  createdAt: string;
  explanation?: Explanation;
}
export interface Comparison {
  id: string;
  projectId: string;
  title: string;
  baselineId: string;
  currentId: string;
  input: PackageInput;
  revision: number;
  explanationVersion: number;
  explanation: Explanation;
  reviewStatus: ReviewStatus;
  createdAt: string;
  runs: Analysis[];
  reviews?: Review[];
  baseline?: Artifact;
  current?: Artifact;
}
export const SCENES = {
  merge: "需求合入",
  release: "版本发布",
  optimization: "专项优化",
  custom: "自定义对比",
};
export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  draft: "草稿",
  pending: "待审核",
  needs_info: "需补充",
  approved: "通过",
  rejected: "不通过",
};
export const ANALYSIS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  complete: "完成",
  partial: "部分完成",
  failed: "失败",
};
export const FILE_LABELS: Record<FileStatus, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  unchanged: "未变",
};
export function sizeText(
  bytes: number | null,
  unit: SizeUnit | typeof REPORT_SIZE_UNIT,
  digits = 2,
): string {
  if (bytes === null) return "不可用";
  const divisor = unit === "KB" ? 1024 : unit === "MiB" ? 1048576 : 1000000;
  if (unit === "KB") {
    const precision =
      bytes !== 0 && Math.abs(bytes / divisor) < 10 ** -digits
        ? Math.max(digits, 3)
        : digits;
    return `${(bytes / divisor).toFixed(precision)} KB`;
  }
  if (bytes !== 0 && Math.abs(bytes / divisor) < 10 ** -digits)
    return `${bytes} B`;
  return `${(bytes / divisor).toFixed(digits)} ${unit}`;
}
