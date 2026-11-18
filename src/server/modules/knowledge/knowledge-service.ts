import fs from "node:fs";
import path from "node:path";
import type {
  KnowledgeDocument,
  KnowledgeLocator,
  KnowledgeLibrarySummary,
  KnowledgeRole,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
} from "@/contracts/knowledge";
import {
  listWorkspaceApps,
  loadWorkspaceAppsConfig,
  resolveKnowledgeBase,
} from "@/lib/workspace-apps-config";

type IndexedDocument = {
  path: string;
  treePath: string;
  title: string;
  summary: string;
  breadcrumb: string[];
  searchText: string;
};

type ResolvedSource = NonNullable<ReturnType<typeof resolveKnowledgeBase>> & {
  id: string;
  label?: string;
  role?: KnowledgeRole;
  provider?: string;
  root: string;
  content_root: string;
  workspace_alias?: string;
  capabilities?: string[];
  query?: { content_root?: string; project_targets?: Record<string, string[]> };
  portal?: {
    enabled?: boolean;
    group?: "technical" | "migration";
    label?: string;
    access?: "authenticated" | "app-scope";
    tree_root?: string;
    path_targets?: Record<string, string>;
  };
  tree_root?: string;
  project_id?: string;
};

type ResolvedLibrary = KnowledgeLibrarySummary & { source: ResolvedSource };

type CacheEntry = {
  expiresAt: number;
  documents: IndexedDocument[];
  readableDocuments: Set<string>;
  assets: Set<string>;
};

const INDEX_TTL_MS = 30_000;
const indexCache = new Map<string, CacheEntry>();
const MARKDOWN_EXT = /\.md$/i;
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ALLOWED_ASSET_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".xml", "application/xml; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
]);

export class KnowledgeAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function normalizeRel(value: string) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new KnowledgeAccessError("knowledge_path_invalid", 400);
  }
  return path.posix.normalize(normalized);
}

function resolveInside(root: string, relativePath: string) {
  const resolvedRoot = path.resolve(root);
  const relative = normalizeRel(relativePath);
  const absolute = path.resolve(resolvedRoot, ...relative.split("/"));
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KnowledgeAccessError("knowledge_path_forbidden", 403);
  }
  return { absolute, relative };
}

function hasHiddenSegment(relativePath: string) {
  return relativePath.split("/").some((segment) => segment.startsWith(".") && segment !== ".");
}

function assertRealPathInside(root: string, target: string) {
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return realTarget;
  }
  throw new KnowledgeAccessError("knowledge_path_forbidden", 403);
}

function decodeLinkPath(value: string) {
  const clean = value.trim().replace(/^<|>$/g, "").split("#")[0].split("?")[0];
  if (!clean || /^(?:[a-z]+:|\/\/|#)/i.test(clean) || clean.startsWith("/")) return "";
  try {
    return decodeURIComponent(clean).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function referencedPaths(documentPath: string, markdown: string) {
  const values: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) values.push(match[1]);
  for (const match of markdown.matchAll(/<(?:img|a)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)) values.push(match[1]);
  const directory = path.posix.dirname(documentPath);
  const documents = new Set<string>();
  const assets = new Set<string>();
  for (const value of values) {
    const decoded = decodeLinkPath(value);
    if (!decoded) continue;
    const normalized = path.posix.normalize(path.posix.join(directory, decoded));
    if (!normalized || normalized === ".." || normalized.startsWith("../")) continue;
    if (MARKDOWN_EXT.test(normalized)) documents.add(normalized);
    else assets.add(normalized);
  }
  return { documents, assets };
}

function stripFrontmatter(markdown: string) {
  return markdown.replace(FRONTMATTER, "");
}

function frontmatterValue(markdown: string, key: string) {
  const block = FRONTMATTER.exec(markdown)?.[1] || "";
  const match = new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "mi").exec(block);
  return match?.[1]?.trim() || "";
}

function markdownTitle(markdown: string, fallback: string) {
  const frontTitle = frontmatterValue(markdown, "title") || frontmatterValue(markdown, "sidebarTitle");
  if (frontTitle) return frontTitle;
  const heading = /^#\s+(.+?)\s*$/m.exec(stripFrontmatter(markdown));
  return heading?.[1]?.replace(/\s+#+\s*$/, "").trim() || fallback;
}

function markdownPlainText(markdown: string) {
  return stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSummary(markdown: string) {
  return markdownPlainText(markdown).slice(0, 180);
}

function searchSummary(query: string, markdown: string) {
  const text = markdownPlainText(markdown);
  const normalized = text.toLocaleLowerCase();
  const candidates = [query, ...query.split(/\s+/)]
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
  const positions = candidates.map((item) => normalized.indexOf(item)).filter((index) => index >= 0);
  if (!positions.length) return text.slice(0, 220);
  const matchAt = Math.min(...positions);
  const start = Math.max(0, matchAt - 72);
  const end = Math.min(text.length, matchAt + 180);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function sourceRole(source: ResolvedSource): KnowledgeRole {
  return source.role === "canonical" || source.role === "evidence" || source.role === "codegraph"
    ? source.role
    : "reference";
}

function canBrowse(source: ResolvedSource) {
  const capabilities = Array.isArray(source.capabilities) ? source.capabilities : [];
  return source.portal?.enabled === true
    || capabilities.includes("browse")
    || capabilities.includes("document-search");
}

function allowedAppIds(scopeIds: readonly string[]) {
  const configured = listWorkspaceApps(loadWorkspaceAppsConfig()).map((app) => app.app_id);
  if (!scopeIds.length) return new Set(configured);
  const requested = new Set(scopeIds);
  return new Set(configured.filter((id) => requested.has(id)));
}

function normalizedSubpath(value: unknown) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function resolvePortalLibraries(): ResolvedLibrary[] {
  const config = loadWorkspaceAppsConfig();
  return (config.shared_knowledge_bases || []).flatMap((entry) => {
    const portal = entry.portal as ResolvedSource["portal"];
    if (
      entry.enabled === false
      || portal?.enabled !== true
      || (portal.group !== "technical" && portal.group !== "migration")
    ) return [];
    const resolved = resolveKnowledgeBase(String(entry.id || ""), config) as ResolvedSource | null;
    if (!resolved?.root || !canBrowse(resolved)) return [];
    const contentSubpath = normalizedSubpath(resolved.query?.content_root);
    const contentRoot = contentSubpath ? path.resolve(resolved.root, ...contentSubpath.split("/")) : resolved.root;
    const treeRoot = normalizedSubpath(portal.tree_root);
    const source: ResolvedSource = {
      ...resolved,
      id: String(entry.id),
      role: portal.group === "migration" ? "evidence" : resolved.role || "canonical",
      content_root: contentRoot,
      tree_root: treeRoot,
      portal,
    };
    return [{
      libraryId: `${portal.group}:${source.id}`,
      label: portal.label || source.label || source.id,
      group: portal.group,
      sourceId: source.id,
      sourceLabel: source.label || source.id,
      workspaceAlias: String(source.workspace_alias || source.id),
      role: sourceRole(source),
      documentCount: 0,
      source,
    }];
  });
}

function resolveLibraries() {
  return resolvePortalLibraries();
}

function pathTargetAppId(
  source: ResolvedSource,
  relativePath: string,
  allowedScopeIds: readonly string[],
) {
  const normalized = normalizeRel(relativePath);
  const match = Object.entries(source.portal?.path_targets || {})
    .map(([prefix, appScopeId]) => [normalizedSubpath(prefix), String(appScopeId || "").trim()] as const)
    .filter(([prefix, appScopeId]) => (
      prefix
      && appScopeId
      && (normalized === prefix || normalized.startsWith(`${prefix}/`))
    ))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (!match) return undefined;
  return allowedAppIds(allowedScopeIds).has(match[1]) ? match[1] : undefined;
}

function sourceTreeRoot(source: ResolvedSource) {
  if (!source.tree_root) return source.content_root;
  return resolveInside(source.content_root, source.tree_root).absolute;
}

function sourceAvailable(source: ResolvedSource) {
  if (!source.content_root || !fs.existsSync(source.content_root)) return false;
  const treeRoot = sourceTreeRoot(source);
  return fs.existsSync(treeRoot) && fs.statSync(treeRoot).isDirectory();
}

function requireLibrary(libraryId: string, _allowedScopeIds: readonly string[]) {
  const id = String(libraryId || "").trim();
  if (!id) throw new KnowledgeAccessError("knowledge_library_required", 400);
  const library = resolveLibraries().find((item) => item.libraryId === id);
  if (!library) throw new KnowledgeAccessError("knowledge_library_not_found", 404);
  if (!sourceAvailable(library.source)) {
    throw new KnowledgeAccessError("knowledge_source_unavailable", 503);
  }
  return library;
}

function walkMarkdown(root: string, current = root, out: string[] = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walkMarkdown(root, absolute, out);
    else if (entry.isFile() && MARKDOWN_EXT.test(entry.name)) {
      out.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  return out;
}

function genericDocuments(source: ResolvedSource) {
  const treeRoot = sourceTreeRoot(source);
  const treePrefix = source.tree_root ? `${source.tree_root}/` : "";
  const documents = walkMarkdown(treeRoot).map((treePath) => {
    const relativePath = `${treePrefix}${treePath}`;
    const absolute = resolveInside(source.content_root, relativePath).absolute;
    const markdown = fs.readFileSync(assertRealPathInside(source.content_root, absolute), "utf8");
    const fileName = path.posix.basename(relativePath, ".md");
    return {
      path: relativePath,
      treePath,
      title: markdownTitle(markdown, fileName === "README" ? path.posix.basename(path.posix.dirname(relativePath)) : fileName),
      summary: textSummary(markdown),
      breadcrumb: treePath.split("/").slice(0, -1),
      searchText: stripFrontmatter(markdown),
    };
  });

  const readableDocuments = new Set(documents.map((document) => document.path));
  const assets = new Set<string>();
  const pending = documents.map((document) => ({ path: document.path, markdown: document.searchText }));
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current.path)) continue;
    visited.add(current.path);
    const references = referencedPaths(current.path, current.markdown);
    for (const asset of references.assets) assets.add(asset);
    for (const documentPath of references.documents) {
      readableDocuments.add(documentPath);
      if (visited.has(documentPath) || hasHiddenSegment(documentPath)) continue;
      const resolved = resolveInside(source.content_root, documentPath);
      if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) continue;
      try {
        const realPath = assertRealPathInside(source.content_root, resolved.absolute);
        pending.push({ path: documentPath, markdown: fs.readFileSync(realPath, "utf8") });
      } catch {
        // Keep the path denied at read time, but never follow an escaping symlink while indexing.
      }
    }
  }
  return { documents, readableDocuments, assets };
}

function indexedDocuments(source: ResolvedSource) {
  const key = `${source.id}:${source.content_root}:${source.tree_root || "."}`;
  const hit = indexCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.documents;
  const { documents, readableDocuments, assets } = genericDocuments(source);
  documents.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  indexCache.set(key, { expiresAt: Date.now() + INDEX_TTL_MS, documents, readableDocuments, assets });
  return documents;
}

function indexedReadableDocuments(source: ResolvedSource) {
  indexedDocuments(source);
  const key = `${source.id}:${source.content_root}:${source.tree_root || "."}`;
  return indexCache.get(key)?.readableDocuments || new Set<string>();
}

function indexedAssets(source: ResolvedSource) {
  indexedDocuments(source);
  const key = `${source.id}:${source.content_root}:${source.tree_root || "."}`;
  return indexCache.get(key)?.assets || new Set<string>();
}

type MutableTreeNode = KnowledgeTreeNode & { children: MutableTreeNode[] };

function documentTree(documents: IndexedDocument[]): KnowledgeTreeNode[] {
  const roots: MutableTreeNode[] = [];
  const directoryMap = new Map<string, MutableTreeNode>();
  const ensureDirectory = (segments: string[]) => {
    let parent = roots;
    let currentPath = "";
    let current: MutableTreeNode | null = null;
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      current = directoryMap.get(currentPath) || null;
      if (!current) {
        current = { key: `dir:${currentPath}`, title: segment, kind: "directory", children: [] };
        directoryMap.set(currentPath, current);
        parent.push(current);
      }
      parent = current.children;
    }
    return current;
  };

  for (const document of documents) {
    const segments = document.treePath.split("/");
    const file = segments.pop() || "";
    const directory = ensureDirectory(segments);
    if (/^README\.md$/i.test(file) && directory) {
      directory.path = document.path;
      directory.title = document.title || directory.title;
      continue;
    }
    const node: MutableTreeNode = {
      key: `doc:${document.path}`,
      title: document.title,
      kind: "document",
      path: document.path,
      children: [],
    };
    if (directory) directory.children.push(node);
    else roots.push(node);
  }

  const sort = (nodes: MutableTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.path && /^README\.md$/i.test(path.posix.basename(a.path))) return -1;
      if (b.path && /^README\.md$/i.test(path.posix.basename(b.path))) return 1;
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.title.localeCompare(b.title, "zh-CN");
    });
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

export function listKnowledgeCatalog(allowedScopeIds: readonly string[], options: { group?: KnowledgeLibrarySummary['group']; counts?: boolean } = {}): KnowledgeLibrarySummary[] {
  void allowedScopeIds;
  return resolveLibraries()
    .filter(library => !options.group || library.group === options.group)
    .map(({ source, ...library }) => ({
      ...library,
      documentCount: options.counts !== false && sourceAvailable(source) ? indexedDocuments(source).length : 0,
    }));
}

export function getKnowledgeTree(input: {
  libraryId: string;
  allowedScopeIds: readonly string[];
}) {
  const { source } = requireLibrary(input.libraryId, input.allowedScopeIds);
  return documentTree(indexedDocuments(source));
}

export function readKnowledgeDocument(input: {
  libraryId: string;
  path: string;
  allowedScopeIds: readonly string[];
}): KnowledgeDocument {
  const library = requireLibrary(input.libraryId, input.allowedScopeIds);
  const { source } = library;
  const relativePath = normalizeRel(input.path);
  if (hasHiddenSegment(relativePath) || !indexedReadableDocuments(source).has(relativePath)) {
    throw new KnowledgeAccessError("knowledge_document_forbidden", 403);
  }
  const indexed = indexedDocuments(source).find((document) => document.path === relativePath);
  const resolved = resolveInside(source.content_root, relativePath);
  if (!MARKDOWN_EXT.test(relativePath) || !fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
    throw new KnowledgeAccessError("knowledge_document_not_found", 404);
  }
  const markdown = fs.readFileSync(assertRealPathInside(source.content_root, resolved.absolute), "utf8");
  return {
    libraryId: library.libraryId,
    appScopeId: pathTargetAppId(source, relativePath, input.allowedScopeIds),
    sourceId: source.id,
    sourceLabel: source.label || source.id,
    workspaceAlias: String(source.workspace_alias || source.id),
    role: sourceRole(source),
    path: relativePath,
    title: indexed?.title || markdownTitle(markdown, path.posix.basename(relativePath, ".md")),
    markdown: stripFrontmatter(markdown),
    locator: {
      libraryId: library.libraryId,
      sourceId: source.id,
      workspaceAlias: String(source.workspace_alias || source.id),
      docPath: relativePath,
      ...(pathTargetAppId(source, relativePath, input.allowedScopeIds)
        ? { appScopeId: pathTargetAppId(source, relativePath, input.allowedScopeIds) }
        : {}),
    },
  };
}

function scoreDocument(query: string, document: IndexedDocument, markdown: string) {
  const normalized = query.toLocaleLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const title = document.title.toLocaleLowerCase();
  const sourcePath = document.path.toLocaleLowerCase();
  const content = markdown.toLocaleLowerCase();
  let score = title === normalized ? 1000 : title.includes(normalized) ? 600 : 0;
  if (sourcePath.includes(normalized)) score += 300;
  if (content.includes(normalized)) score += 180;
  for (const term of terms) {
    if (title.includes(term)) score += 120;
    if (sourcePath.includes(term)) score += 50;
    if (content.includes(term)) score += 20;
  }
  return score;
}

export function searchKnowledgeDocuments(input: {
  libraryId: string;
  query: string;
  allowedScopeIds: readonly string[];
}): KnowledgeSearchHit[] {
  const library = requireLibrary(input.libraryId, input.allowedScopeIds);
  const query = String(input.query || "").trim().slice(0, 100);
  if (!query) return [];
  return indexedDocuments(library.source)
    .map((document) => {
      return {
        libraryId: library.libraryId,
        appScopeId: pathTargetAppId(library.source, document.path, input.allowedScopeIds),
        sourceId: library.source.id,
        sourceLabel: library.source.label || library.source.id,
        workspaceAlias: String(library.source.workspace_alias || library.source.id),
        role: sourceRole(library.source),
        path: document.path,
        title: document.title,
        summary: searchSummary(query, document.searchText),
        score: scoreDocument(query, document, document.searchText),
      } satisfies KnowledgeSearchHit;
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, 50);
}

export function readKnowledgeAsset(input: {
  libraryId: string;
  path: string;
  allowedScopeIds: readonly string[];
}) {
  const { source } = requireLibrary(input.libraryId, input.allowedScopeIds);
  const resolved = resolveInside(source.content_root, input.path);
  if (hasHiddenSegment(resolved.relative)) {
    throw new KnowledgeAccessError("knowledge_asset_type_forbidden", 403);
  }
  const extension = path.extname(resolved.relative).toLowerCase();
  const contentType = ALLOWED_ASSET_TYPES.get(extension);
  if (!contentType || !indexedAssets(source).has(resolved.relative)) {
    throw new KnowledgeAccessError("knowledge_asset_type_forbidden", 403);
  }
  if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
    throw new KnowledgeAccessError("knowledge_asset_not_found", 404);
  }
  if (MARKDOWN_EXT.test(resolved.relative)) {
    throw new KnowledgeAccessError("knowledge_asset_type_forbidden", 403);
  }
  const realPath = assertRealPathInside(source.content_root, resolved.absolute);
  const stat = fs.statSync(realPath);
  if (stat.size > MAX_ASSET_BYTES) {
    throw new KnowledgeAccessError("knowledge_asset_too_large", 413);
  }
  return { bytes: fs.readFileSync(realPath), path: resolved.relative, contentType };
}

export function validateKnowledgeLocator(input: {
  locator: KnowledgeLocator;
  allowedScopeIds: readonly string[];
}): KnowledgeLocator {
  const locator = input.locator;
  const document = readKnowledgeDocument({
    libraryId: String(locator?.libraryId || ""),
    path: String(locator?.docPath || ""),
    allowedScopeIds: input.allowedScopeIds,
  });
  if (
    locator.sourceId !== document.sourceId
    || locator.workspaceAlias !== document.workspaceAlias
    || (locator.appScopeId || undefined) !== (document.appScopeId || undefined)
  ) {
    throw new KnowledgeAccessError("knowledge_locator_mismatch", 400);
  }
  return document.locator;
}

export function resolveKnowledgeLocatorFromMessage(input: {
  message: string;
  allowedScopeIds: readonly string[];
}): KnowledgeLocator | null {
  const message = String(input.message || "").replace(/\\/g, "/");
  if (!message.toLowerCase().includes(".md")) return null;

  const matches: KnowledgeDocument[] = [];
  for (const library of resolveLibraries()) {
    if (!sourceAvailable(library.source)) continue;
    for (const document of indexedDocuments(library.source)) {
      if (!message.includes(document.path)) continue;
      matches.push(readKnowledgeDocument({
        libraryId: library.libraryId,
        path: document.path,
        allowedScopeIds: input.allowedScopeIds,
      }));
    }
  }

  return matches.length === 1 ? matches[0].locator : null;
}

export function resetKnowledgeIndexCache() {
  indexCache.clear();
}
