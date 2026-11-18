import {
  HARMONY_MODULE_SEGMENT,
  MONOREPO_PROJECT_ID,
} from "@/lib/module-prefix-constants";

export type ModulePrefixPlatform = "android" | "harmony";

export type ParsedModulePrefix = {
  projectId: string;
  projectLabel: string;
  modulePath: string;
  platform: ModulePrefixPlatform;
};

export type ParseScopedModulePrefixOptions = {
  projectLabels?: Record<string, string>;
};

export function normalizeModulePrefix(raw: string) {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p === ".") return "";
  return p.endsWith("/") ? p : `${p}/`;
}

export function isHarmonyScopedModulePrefix(prefix: string) {
  const normalized = normalizeModulePrefix(prefix).replace(/\/$/, "");
  const slash = normalized.indexOf("/");
  if (slash <= 0) return false;
  const projectId = normalized.slice(0, slash);
  if (projectId === MONOREPO_PROJECT_ID) return false;
  const rest = normalized.slice(slash + 1);
  return rest === HARMONY_MODULE_SEGMENT || rest.startsWith(`${HARMONY_MODULE_SEGMENT}/`);
}

export function parseScopedModulePrefix(
  prefix: string,
  options?: ParseScopedModulePrefixOptions,
): ParsedModulePrefix {
  const labels = options?.projectLabels || {};
  const normalized = normalizeModulePrefix(prefix).replace(/\/$/, "");
  const slash = normalized.indexOf("/");
  if (slash <= 0) {
    return {
      projectId: MONOREPO_PROJECT_ID,
      projectLabel: MONOREPO_PROJECT_ID,
      modulePath: normalized ? `${normalized}/` : prefix,
      platform: "android",
    };
  }
  const projectId = normalized.slice(0, slash);
  if (projectId === MONOREPO_PROJECT_ID) {
    return {
      projectId,
      projectLabel: MONOREPO_PROJECT_ID,
      modulePath: `${normalized.slice(slash + 1)}/`,
      platform: "android",
    };
  }
  const projectLabel = labels[projectId] || projectId;
  const rest = normalized.slice(slash + 1);
  if (rest === HARMONY_MODULE_SEGMENT || rest.startsWith(`${HARMONY_MODULE_SEGMENT}/`)) {
    const harmonyTail =
      rest === HARMONY_MODULE_SEGMENT ? "" : rest.slice(HARMONY_MODULE_SEGMENT.length + 1);
    return {
      projectId,
      projectLabel,
      modulePath: harmonyTail ? `${harmonyTail}/` : "(全仓)/",
      platform: "harmony",
    };
  }
  return {
    projectId,
    projectLabel,
    modulePath: `${rest}/`,
    platform: "android",
  };
}
