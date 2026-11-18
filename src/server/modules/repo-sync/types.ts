export type RepoSyncDeployOnChange = {
  /** 在仓库项目根目录执行；有代码变更才跑 */
  commands: string[][];
  /** 工台自部署：分离进程，避免 worker 被 pm2 reload 打断 */
  detached?: boolean;
};

export type RepoSyncConfigRepo = {
  id: string;
  label: string;
  path: string;
  source_id?: string;
  platform?: string;
  /** 嵌套 Git 子仓相对父仓根目录。 */
  path_suffix?: string;
  remote_match: string[];
  track_branches: string[];
  codegraph_projects: string[];
  deploy_on_change?: RepoSyncDeployOnChange;
  /** 机器本地路径等已跟踪文件：pull 时备份后还原，不因此判定 working_tree_dirty */
  preserve_local_files?: string[];
};

export type RepoSyncConfig = {
  schema_version: string;
  deployment_id_env?: string;
  debounce_ms: number;
  queue_dir_env?: string;
  workbench_repository?: {
    id?: string;
    label?: string;
    remote_match?: string[];
    branches?: string[];
    deploy_on_change?: RepoSyncDeployOnChange;
    preserve_local_files?: string[];
  };
};

export type RepoSyncJobPayload = {
  runId: string;
  repoIds: string[];
  repoPath: string;
  branch: string;
  trigger: string;
  commitSha?: string;
  codegraphProjects: string[];
  enqueuedAt: string;
};

export type GitLabWebhookEvent =
  | { kind: "push"; remoteKey: string; branch: string; commitSha: string }
  | { kind: "merge"; remoteKey: string; branch: string; commitSha: string }
  | { kind: "ignored"; reason: string };

export type RepoSyncDeployResult = {
  skipped?: boolean;
  reason?: string;
  detached?: boolean;
  pid?: number;
  cwd?: string;
  log_file?: string;
  commands?: Array<{ command: string; status: number | null; skipped?: boolean; reason?: string }>;
};

export type RepoSyncRunResult = {
  pull?: { before?: string; after?: string; skipped?: boolean; reason?: string; preserved?: string[] };
  codegraph?: unknown;
  indexing?: { skipped?: boolean; reason?: string; count?: number; slices?: string };
  deploy?: RepoSyncDeployResult;
};
