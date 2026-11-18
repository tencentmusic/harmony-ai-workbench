import fs from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig, resolveKnowledgeBase } from "@kugou/workspace-config";

const KB_MARKER = path.join("scripts", "cli", "codegraph-sync.mjs");

function validKbRoot(value: string): string | null {
  const root = path.resolve(value);
  return fs.existsSync(path.join(root, KB_MARKER)) ? root : null;
}

export function resolveKnowledgeBaseRoot(): string | null {
  const config = loadWorkspaceConfig({ repoRoot: process.cwd() });
  const configured = resolveKnowledgeBase("android-harmony-kb", config)?.root;
  return configured ? validKbRoot(configured) : null;
}

export function requireKnowledgeBaseRoot(): string {
  const root = resolveKnowledgeBaseRoot();
  if (root) return root;
  throw new Error(
    "knowledge_base_missing: check shared_knowledge_bases id=android-harmony-kb in workspace-apps.json",
  );
}
