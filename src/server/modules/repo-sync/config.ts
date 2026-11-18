import fs from "node:fs";
import path from "node:path";
import type { RepoSyncConfig, RepoSyncConfigRepo } from "./types";
import {
  listRepoSyncRepositories,
  loadWorkspaceAppsConfig,
  resetWorkspaceConfigCache,
} from "@/lib/workspace-apps-config";

let cached: RepoSyncConfig | null = null;

function repoRoot(): string {
  return path.resolve(process.cwd());
}

export function loadRepoSyncConfig(): RepoSyncConfig {
  if (cached) return cached;
  const file = path.join(repoRoot(), "config", "repo-sync.json");
  const raw = fs.readFileSync(file, "utf8");
  cached = JSON.parse(raw) as RepoSyncConfig;
  return cached;
}

export function resetRepoSyncConfigCache(): void {
  cached = null;
  resetWorkspaceConfigCache();
}

export function getDeploymentId(): string {
  const cfg = loadRepoSyncConfig();
  const envKey = cfg.deployment_id_env || "REPO_SYNC_DEPLOYMENT_ID";
  return String(process.env[envKey] || "local").trim() || "local";
}

export function resolveRepoPath(repo: RepoSyncConfigRepo): string | null {
  const raw = String(repo.path || "").trim();
  return raw ? path.resolve(raw) : null;
}

function configuredRepos(): RepoSyncConfigRepo[] {
  const workspace = loadWorkspaceAppsConfig();
  const self = loadRepoSyncConfig().workbench_repository;
  const rows = listRepoSyncRepositories(workspace) as RepoSyncConfigRepo[];
  if (!self) return rows;
  return [
    {
      id: self.id || "kugou-harmony-ai-workbench",
      label: self.label || "鸿蒙 AI 工台",
      path: workspace.repo_root,
      source_id: "workbench",
      platform: "workbench",
      remote_match: self.remote_match || [],
      track_branches: self.branches || [],
      codegraph_projects: [],
      deploy_on_change: self.deploy_on_change,
      preserve_local_files: self.preserve_local_files,
    },
    ...rows,
  ];
}

export function listConfiguredRepos(): RepoSyncConfigRepo[] {
  return configuredRepos().flatMap((repo) => {
    const resolved = resolveRepoPath(repo);
    return resolved ? [{ ...repo, path: resolved }] : [];
  });
}

export function getRepoById(repoId: string): RepoSyncConfigRepo | null {
  const repo = configuredRepos().find((r) => r.id === repoId);
  if (!repo) return null;
  const resolved = resolveRepoPath(repo);
  return resolved ? { ...repo, path: resolved } : null;
}

export function getPreserveLocalFiles(repoIds: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const id of repoIds) {
    const repo = configuredRepos().find((item) => item.id === id);
    for (const rel of repo?.preserve_local_files || []) {
      const normalized = String(rel || "").trim().replace(/\\/g, "/");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      files.push(normalized);
    }
  }
  return files;
}

export function getDeployOnChange(repoIds: string[]): RepoSyncConfigRepo["deploy_on_change"] | null {
  const repos = configuredRepos();
  for (const id of repoIds) {
    const repo = repos.find((r) => r.id === id);
    if (repo?.deploy_on_change?.commands?.length) return repo.deploy_on_change;
  }
  return null;
}

export function getQueueDir(): string {
  const cfg = loadRepoSyncConfig();
  const envKey = cfg.queue_dir_env || "REPO_SYNC_QUEUE_DIR";
  const custom = String(process.env[envKey] || "").trim();
  if (custom) return path.resolve(custom);
  return path.join(repoRoot(), "data", "repo-sync", "queue");
}

export function getLockDir(): string {
  return path.join(repoRoot(), "data", "repo-sync", "locks");
}

export function getQueueMetaDir(): string {
  return path.dirname(getQueueDir());
}

export function getDebounceMs(): number {
  const ms = loadRepoSyncConfig().debounce_ms;
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

export function jobRestartsWorker(repoIds: string[]): boolean {
  return getDeployOnChange(repoIds)?.detached === true;
}
