import fs from "node:fs";
import path from "node:path";
import { loadWorkspaceAppsConfig } from "@/lib/workspace-apps-config";
import type {
  CategoryRule,
  MappingRule,
  Metadata,
  PackageInput,
  PackageProject,
  PackageRules,
} from "./types";
import { DEFAULT_IMAGE_FILE_BYTES } from "./assessment";

export class PackageError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function check(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new PackageError(message, status);
}
export function object(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "必须提供对象",
  );
  return value as Record<string, unknown>;
}
export function string(
  value: unknown,
  label: string,
  required = false,
  max = 4000,
): string {
  check(
    value === undefined || value === null || typeof value === "string",
    `${label}格式错误`,
  );
  const s = String(value ?? "").trim();
  check(
    s.length <= max &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) &&
      (!required || s.length > 0),
    `${label}为空或超过长度限制`,
  );
  return s;
}
function number(value: unknown, label: string, integer = true): number | null {
  if (value === null || value === undefined) return null;
  check(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER &&
      (!integer || Number.isSafeInteger(value)),
    `${label}必须为非负${integer ? "整数字节" : "数字"}`,
  );
  return value;
}
function strings(value: unknown, label: string): string[] {
  check(
    value === undefined || (Array.isArray(value) && value.length <= 100),
    `${label}需为数组，最多100项`,
  );
  return ((value as unknown[]) || []).map((v) => string(v, label, true, 512));
}
export const defaultRules: PackageRules = {
  version: "1",
  unit: "MiB",
  targetArchitectures: [],
  budgetBytes: null,
  growthPercent: null,
  largeFileBytes: null,
  fileGrowthBytes: null,
  imageFileBytes: DEFAULT_IMAGE_FILE_BYTES,
  groups: [],
  modules: [],
  categories: [],
};
export function parseRules(value: unknown): PackageRules {
  const v = { ...defaultRules, ...object(value) };
  check(["MB", "MiB"].includes(v.unit as string), "单位必须是 MB 或 MiB");
  function mappings(value: unknown): MappingRule[] {
    check(Array.isArray(value) && value.length <= 100, "路径分组最多100项");
    return value.map((x) => {
      const r = object(x);
      return {
        prefix: string(r.prefix, "路径前缀", true, 512),
        name: string(r.name, "分组名称", true, 120),
        owner: string(r.owner, "负责人", false, 120),
      };
    });
  }
  check(
    Array.isArray(v.categories) && v.categories.length <= 100,
    "分类规则最多100项",
  );
  const categories: CategoryRule[] = v.categories.map((x) => {
    const r = object(x);
    const extensions = strings(r.extensions, "扩展名");
    const prefix = string(r.prefix, "路径前缀", false, 512);
    check(extensions.length || prefix, "分类规则需指定路径前缀或扩展名");
    return {
      category: string(r.category, "分类名称", true, 120),
      extensions,
      prefix,
    };
  });
  return {
    version: string(v.version, "规则版本", true, 80),
    unit: v.unit as PackageRules["unit"],
    targetArchitectures: strings(v.targetArchitectures, "目标架构"),
    budgetBytes: number(v.budgetBytes, "预算"),
    growthPercent: number(v.growthPercent, "增长比例", false),
    largeFileBytes: number(v.largeFileBytes, "大文件阈值"),
    fileGrowthBytes: number(v.fileGrowthBytes, "文件增长阈值"),
    imageFileBytes: number(v.imageFileBytes, "单张图片阈值"),
    groups: mappings(v.groups),
    modules: mappings(v.modules),
    categories,
  };
}
export function parseMetadata(value: unknown): Metadata {
  if (!value) return {};
  const v = object(value),
    out: Metadata = {};
  for (const key of [
    "applicationId",
    "version",
    "build",
    "commit",
    "buildTime",
    "channel",
    "variant",
    "architectures",
    "mode",
    "toolchain",
    "compression",
  ])
    out[key] = string(v[key], key, false, 512);
  return out;
}
export function packageProjects(): PackageProject[] {
  const file = process.env.PACKAGE_COMPARISON_CONFIG;
  const configured = file
    ? object(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")))
    : {};
  return loadWorkspaceAppsConfig()
    .apps.filter((a) => (a.status || "active") === "active")
    .map((a) => ({
      id: a.scope_id,
      label: a.label,
      platform: "HarmonyOS",
      formats: ["app", "hap"],
      rules: parseRules(configured[a.scope_id] || defaultRules),
    }));
}
export function parseInput(
  value: unknown,
  projects: PackageProject[],
): PackageInput {
  const v = object(value),
    project = projects.find((p) => p.id === v.projectId);
  check(project, "项目不存在或无访问权限", 403);
  check(
    ["merge", "release", "optimization", "custom"].includes(v.scene as string),
    "对比场景无效",
  );
  return {
    title: string(v.title, "任务名称", true, 160),
    projectId: project.id,
    scene: v.scene as string,
    requirement: string(v.requirement, "关联需求"),
    owner: string(v.owner, "负责人", true, 120),
    scope: strings(v.scope, "需求范围"),
    rules: parseRules(v.rules || project.rules),
    baselineMetadata: parseMetadata(v.baselineMetadata),
    currentMetadata: parseMetadata(v.currentMetadata),
    compatibilityNote: string(v.compatibilityNote, "可比性说明"),
  };
}
function limit(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(process.env[name] || fallback);
  check(Number.isSafeInteger(n) && n > 0 && n <= max, `${name} 配置无效`, 500);
  return n;
}
export function packageLimits() {
  return {
    uploadBytes: limit("PACKAGE_UPLOAD_BYTES", 512 * 1024 * 1024),
    fileBytes: limit("PACKAGE_FILE_BYTES", 256 * 1024 * 1024),
    expandedBytes: limit("PACKAGE_EXPANDED_BYTES", 2 * 1024 * 1024 * 1024),
    fileCount: limit("PACKAGE_FILE_COUNT", 30000, 60000),
    timeoutMs: limit("PACKAGE_ANALYSIS_TIMEOUT_MS", 180000, 1800000),
    concurrency: limit("PACKAGE_ANALYSIS_CONCURRENCY", 1, 4),
    retentionDays: limit("PACKAGE_RETENTION_DAYS", 30, 36500),
  };
}
export function packageRoot() {
  return path.resolve(
    process.env.PACKAGE_STORAGE_DIR ||
      path.join(process.cwd(), ".runtime", "package-comparison"),
  );
}
