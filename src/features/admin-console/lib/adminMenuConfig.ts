import type { MenuKey } from "../types";

export type MenuGroupKey = "kb" | "ai" | "system";

export const MENU_GROUP_BY_KEY: Record<MenuKey, MenuGroupKey | null> = {
  overview: null,
  kbRoi: "kb",
  knowledge: "kb",
  repoSync: "kb",
  usage: "ai",
  requests: "ai",
  zcMcpAudit: "ai",
  tokens: "system",
  feedback: "system",
};

const MENU_LEAF_KEYS = new Set<MenuKey>([
  "overview",
  "kbRoi",
  "knowledge",
  "repoSync",
  "usage",
  "requests",
  "feedback",
  "zcMcpAudit",
  "tokens",
]);

export function isMenuLeafKey(key: string): key is MenuKey {
  return MENU_LEAF_KEYS.has(key as MenuKey);
}

export function defaultOpenKeysForMenu(menuKey: MenuKey): string[] {
  const group = MENU_GROUP_BY_KEY[menuKey];
  return group ? [group] : [];
}
