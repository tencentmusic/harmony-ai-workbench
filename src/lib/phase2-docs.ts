import fs from "fs";
import path from "path";
import { listPortalKnowledgeBases, loadWorkspaceAppsConfig } from "@/lib/workspace-apps-config";

function getDocsRoots() {
  const config = loadWorkspaceAppsConfig();
  return listPortalKnowledgeBases("migration", config).map((source) => {
    const contentSubpath = String(source.query?.content_root || "").trim().replace(/\\/g, "/");
    const contentRoot = contentSubpath
      ? path.resolve(source.root, ...contentSubpath.split("/").filter(Boolean))
      : path.resolve(source.root);
    const treeSubpath = String(source.portal?.tree_root || "").trim().replace(/\\/g, "/");
    const treeRoot = treeSubpath
      ? path.resolve(contentRoot, ...treeSubpath.split("/").filter(Boolean))
      : contentRoot;
    return { libraryId: `migration:${source.id}`, contentRoot, treeRoot };
  });
}

function walkMarkdownFiles(dir: string, out: string[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkMarkdownFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".md")) out.push(full);
  }
}

export function listMigrationMarkdownRelPaths(): string[] {
  return listMigrationMarkdownDocuments().map((item) => `${item.libraryId}/${item.relPath}`);
}

export function listMigrationMarkdownDocuments() {
  return getDocsRoots().flatMap(({ libraryId, contentRoot, treeRoot }) => {
    if (!fs.existsSync(treeRoot)) return [];
    const files: string[] = [];
    walkMarkdownFiles(treeRoot, files);
    return files.map((file) => ({ libraryId, relPath: toRelPath(contentRoot, file) }));
  }).sort((a, b) => `${a.libraryId}/${a.relPath}`.localeCompare(`${b.libraryId}/${b.relPath}`, "zh-CN"));
}

export function countMigrationDocs() {
  return listMigrationMarkdownRelPaths().length;
}

/** 将案例相对路径转为原生知识门户路由前缀，用于与 page_view.docPath 匹配。 */
export function migrationRelPathToDocPrefixes(relPath: string, libraryId: string) {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutMd = clean.replace(/\.md$/i, "");
  const base = `/knowledge/${libraryId}/${withoutMd}`;
  if (clean.endsWith("/README.md") || clean.endsWith("README.md")) {
    const dir = base.replace(/\/README$/i, "");
    return [dir, `${dir}/`, `${dir}.html`];
  }
  return [base, `${base}.html`, `${base}/`];
}

function toRelPath(root: string, full: string) {
  return path.relative(root, full).replace(/\\/g, "/");
}
