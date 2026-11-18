import fs from "node:fs/promises";
import path from "node:path";

import {
  getHarmonyAppScopePrefixes,
  getHarmonyWorkspaceAliasForScope,
  parseAndroidAppScopes,
} from "@/lib/android-app-scopes";
import { getAgentWorkspaceCwd } from "@/lib/agent-backend/resolve-backend";
import { buildOpencodeHeaders, getOpencodeConfig } from "@/lib/opencode/opencode-config";
import { mimeFromAssetPath, normalizeOpencodeImagePath } from "@/lib/opencode/opencode-image";
import { listWorkspaceLinks, loadWorkspaceAppsConfig } from "@/lib/workspace-apps-config";

const MAX_ASSET_BYTES = 12 * 1024 * 1024;
const DRAWABLE_DENSITY_DIRS = ["drawable-hdpi", "drawable-xhdpi", "drawable-xxhdpi", "drawable-xxxhdpi"] as const;

type FileContentResponse = { content?: string; encoding?: string };

export class OpencodeAssetError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}

function pathMatchesPrefixes(relativePath: string, prefixes: readonly string[], matchAll?: boolean) {
  if (matchAll || prefixes.includes(".")) return true;
  return prefixes.some((prefix) => {
    const normalized = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return normalized && (relativePath === normalized || relativePath.startsWith(`${normalized}/`));
  });
}

function sourceScopeIds(alias: string, relativePath: string) {
  const owners = new Set<string>();
  for (const scope of parseAndroidAppScopes()) {
    if (scope.workspaceAlias === alias && pathMatchesPrefixes(relativePath, scope.prefixes, scope.matchAll)) {
      owners.add(scope.id);
    }
    if (
      scope.harmonyRepoRoot
      && getHarmonyWorkspaceAliasForScope(scope) === alias
      && pathMatchesPrefixes(relativePath, getHarmonyAppScopePrefixes(scope.id), scope.harmonyMatchAll)
    ) {
      owners.add(scope.id);
    }
  }
  return [...owners];
}

function splitWorkspacePath(assetPath: string) {
  const slash = assetPath.indexOf("/");
  return slash > 0
    ? { alias: assetPath.slice(0, slash), relativePath: assetPath.slice(slash + 1) }
    : { alias: "", relativePath: "" };
}

function hasHiddenSegment(relativePath: string) {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

export function isOpencodeAssetAuthorized(input: {
  path: string;
  allowedScopeIds: readonly string[];
  tokenId?: string;
  admin?: boolean;
}) {
  const normalized = normalizeOpencodeImagePath(input.path);
  if (!normalized) return false;
  const { alias, relativePath } = splitWorkspacePath(normalized);
  if (!alias || !relativePath || hasHiddenSegment(relativePath)) return false;

  if (alias === "user-uploads") {
    return input.admin === true || (!!input.tokenId && relativePath.startsWith(`${input.tokenId}/`));
  }

  const link = listWorkspaceLinks(loadWorkspaceAppsConfig()).find((item) => item.alias === alias);
  if (!link) return false;
  if (link.kind === "knowledge") return true;
  if (input.admin) return true;

  const owners = sourceScopeIds(alias, relativePath);
  if (!owners.length) return false;
  if (!input.allowedScopeIds.length) return true;
  const allowed = new Set(input.allowedScopeIds);
  return owners.some((scopeId) => allowed.has(scopeId));
}

function fallbackPaths(assetPath: string) {
  const match = assetPath.match(/^(.*\/res\/)(drawable-(?:hdpi|xhdpi|xxhdpi|xxxhdpi))(\/[^/]+)$/i);
  if (!match) return [assetPath];
  const [, prefix, currentDir, suffix] = match;
  return [
    assetPath,
    ...DRAWABLE_DENSITY_DIRS
      .map((directory) => `${prefix}${directory}${suffix}`)
      .filter((candidate) => candidate !== `${prefix}${currentDir}${suffix}` && candidate !== assetPath),
  ];
}

function isInside(realRoot: string, realTarget: string) {
  const relative = path.relative(realRoot, realTarget);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readLocalAsset(assetPath: string) {
  const { alias, relativePath } = splitWorkspacePath(assetPath);
  const root = alias === "user-uploads"
    ? getAgentWorkspaceCwd()
    : listWorkspaceLinks(loadWorkspaceAppsConfig()).find((item) => item.alias === alias)?.root;
  if (!root) return null;

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(target)]);
  } catch {
    return null;
  }
  if (!isInside(realRoot, realTarget)) throw new OpencodeAssetError("asset_path_forbidden", 403);
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_ASSET_BYTES) throw new OpencodeAssetError("asset_too_large", 413);
  return fs.readFile(realTarget);
}

export async function readOpencodeAsset(input: {
  path: string;
  allowedScopeIds: readonly string[];
  tokenId?: string;
  admin?: boolean;
}) {
  const normalized = normalizeOpencodeImagePath(input.path);
  if (!normalized || !isOpencodeAssetAuthorized({ ...input, path: normalized })) {
    throw new OpencodeAssetError("asset_forbidden", 403);
  }

  const candidates = fallbackPaths(normalized);
  for (const candidate of candidates) {
    const bytes = await readLocalAsset(candidate);
    if (bytes) return { bytes, contentType: mimeFromAssetPath(candidate) };
  }

  const config = getOpencodeConfig();
  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/file/content?${new URLSearchParams({ path: candidate })}`, {
        cache: "no-store",
        headers: buildOpencodeHeaders(config),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      throw new OpencodeAssetError("asset_upstream_unavailable", 502);
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new OpencodeAssetError("asset_upstream_failed", 502);
    const payload = await response.json() as FileContentResponse;
    if (!payload.content) continue;
    const bytes = payload.encoding === "base64"
      ? Buffer.from(payload.content, "base64")
      : Buffer.from(payload.content, "utf8");
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new OpencodeAssetError("asset_too_large", 413);
    return { bytes, contentType: mimeFromAssetPath(candidate) };
  }
  throw new OpencodeAssetError("asset_not_found", 404);
}
