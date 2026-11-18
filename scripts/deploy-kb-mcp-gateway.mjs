/**
 * 部署 KB 远程 MCP 服务（kb-mcp-for-zc + kb-mcp-for-codegraph）。
 * 知识库根目录统一从 config/workspace-apps.json 解析。
 * 非 Unix 时跳过（非致命）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./load-env-file.mjs";
import { loadWorkspaceConfig, resolveKnowledgeBase } from "@kugou/workspace-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fileEnv = loadEnvFile(path.join(root, ".env.production"));
const runtimeEnv = { ...fileEnv, ...process.env };

const MCP_DEPLOYS = [
  { name: "kb-mcp-for-zc", script: "packages/kb-mcp-gateway/deploy.sh" },
  { name: "kb-mcp-for-codegraph", script: "packages/kb-mcp-codegraph/deploy.sh" },
];

function deployOne(kbRoot, { name, script }) {
  const deploySh = path.join(kbRoot, script);
  if (!fs.existsSync(deploySh)) {
    console.warn(`[deploy-kb-mcp] 未找到 ${deploySh}，跳过 ${name}`);
    return 0;
  }
  console.log(`[deploy-kb-mcp] ${name}: bash ${deploySh}`);
  const result = spawnSync("bash", [deploySh], {
    stdio: "inherit",
    cwd: kbRoot,
    env: {
      ...runtimeEnv,
      NODE_BIN_DIR: runtimeEnv.NODE_BIN_DIR || `${process.env.HOME || ""}/.local/node/bin`,
    },
  });
  if (result.error) {
    console.error(`[deploy-kb-mcp] ${name} 失败:`, result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  if (process.platform === "win32") {
    console.log("[deploy-kb-mcp] Windows 跳过远程 MCP 部署");
    return 0;
  }

  const kbRoot = resolveKnowledgeBase(
    "android-harmony-kb",
    loadWorkspaceConfig({ repoRoot: root, env: runtimeEnv }),
  )?.root;
  if (!kbRoot) throw new Error("workspace_knowledge_base_missing:android-harmony-kb");

  let worst = 0;
  for (const item of MCP_DEPLOYS) {
    const code = deployOne(kbRoot, item);
    if (code !== 0) worst = code;
  }
  return worst;
}

process.exit(main());
