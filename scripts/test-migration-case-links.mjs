#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig, resolveKnowledgeBase } from "@kugou/workspace-config";

const config = loadWorkspaceConfig();
const source = resolveKnowledgeBase("migration-cases", config);
assert.ok(source?.root, "迁移案例知识库未配置");
const contentRoot = String(source.query?.content_root || "").trim();
const root = path.resolve(source.root, contentRoot);
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
const failures = [];
let checked = 0;

function markdownFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) markdownFiles(absolute, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(absolute);
  }
  return output;
}

function linkTarget(raw) {
  const trimmed = raw.trim().replace(/^<|>$/g, "");
  const withoutTitle = trimmed.replace(/\s+["'][^"']*["']\s*$/, "");
  const withoutFragment = withoutTitle.split("#", 1)[0].split("?", 1)[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

for (const file of markdownFiles(root)) {
  const markdown = fs.readFileSync(file, "utf8");
  for (const match of markdown.matchAll(markdownLink)) {
    const target = linkTarget(match[1]);
    if (!target || /^(?:https?:|mailto:|tel:|data:)/i.test(target)) continue;
    checked += 1;
    const rootRelative = target.startsWith("/");
    const rawPath = rootRelative ? target.replace(/^\/+/, "") : target;
    const markdownPath = rawPath.replace(/\.html$/i, ".md");
    const resolved = path.resolve(rootRelative ? root : path.dirname(file), markdownPath);
    const insideRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    const exists = insideRoot && (
      fs.existsSync(resolved) || fs.existsSync(path.join(resolved, "README.md"))
    );
    if (!exists) failures.push(`${path.relative(root, file)} -> ${target}`);
  }
}

assert.deepEqual(failures, [], `迁移案例存在失效或越界链接：\n${failures.join("\n")}`);
console.log(`test:migration-case-links OK (${checked} links)`);
