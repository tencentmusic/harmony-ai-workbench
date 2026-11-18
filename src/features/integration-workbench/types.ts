export type IntegrationTaskStatus =
  | "developing"
  | "submitted"
  | "merge_pending"
  | "merged"
  | "closed";

export type IntegrationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cleanup_pending"
  | "cleaning";

export type IntegrationArtifactType =
  | "initial_review"
  | "test_cases"
  | "final_review";

export type IntegrationStage =
  | "submit_review_and_tests"
  | "pre_merge_review";

export interface IntegrationConflictCheckResult {
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  targetTipSha: string;
  hasConflicts: boolean;
  conflictPaths: string[];
  conflictPathCount: number;
  conflictPathsTruncated: boolean;
  checkedAt: string;
}

export interface IntegrationProject {
  id: string;
  label: string;
  defaultTargetBranch: string;
  scopePath?: string;
  appScopeId?: string;
  selectable?: boolean;
}

export interface IntegrationCreator {
  personName: string;
  personCode: string;
  label: string | null;
}

export interface IntegrationArtifactSummary {
  id: string;
  type: string;
  status: string;
  conclusion: string | null;
  errorCode?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface IntegrationArtifactDetail
  extends IntegrationArtifactSummary {
  content: string | null;
  reviewNote: string | null;
  reviewNoteUpdatedAt: string | null;
  reviewNoteUpdatedBy: string | null;
}

export interface IntegrationRunSummary {
  id: string;
  stage: IntegrationStage;
  sequence: number;
  status: string;
  baseSha?: string | null;
  headSha?: string | null;
  targetTipSha?: string | null;
  diffHash?: string | null;
  errorCode?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  artifacts: IntegrationArtifactSummary[];
}

export interface IntegrationRunDetail
  extends Omit<IntegrationRunSummary, "artifacts"> {
  artifacts: IntegrationArtifactDetail[];
}

export interface IntegrationTaskSummary {
  id: string;
  title: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  scopePath: string | null;
  featureDesc: string | null;
  status: IntegrationTaskStatus;
  automationStatus: string;
  canRetry: boolean;
  retryBlockedReason: string | null;
  rerunnableStages: IntegrationStage[];
  rerunBlockedReason: string | null;
  canDelete: boolean;
  deleteBlockedReason: string | null;
  creator: IntegrationCreator | null;
  createdAt: string;
  updatedAt: string;
  runs: IntegrationRunSummary[];
}

export interface IntegrationTaskDetail
  extends Omit<IntegrationTaskSummary, "runs"> {
  events: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: string;
  }>;
  runs: IntegrationRunDetail[];
}

export interface IntegrationStatusAction {
  status: IntegrationTaskStatus;
  label: string;
  tone: "primary" | "neutral" | "danger";
  automation: "submit" | "merge" | null;
}

const STATUS_ACTIONS: Record<
  IntegrationTaskStatus,
  IntegrationStatusAction[]
> = {
  developing: [
    {
      status: "submitted",
      label: "提交测试",
      tone: "primary",
      automation: "submit",
    },
    { status: "closed", label: "关闭任务", tone: "danger", automation: null },
  ],
  submitted: [
    {
      status: "merge_pending",
      label: "测试完成，待合入",
      tone: "primary",
      automation: "merge",
    },
    { status: "closed", label: "关闭任务", tone: "danger", automation: null },
  ],
  merge_pending: [
    { status: "merged", label: "标记已合入", tone: "neutral", automation: null },
    { status: "closed", label: "关闭任务", tone: "danger", automation: null },
  ],
  merged: [],
  closed: [],
};

export function getStatusActions(
  status: IntegrationTaskStatus,
): IntegrationStatusAction[] {
  return STATUS_ACTIONS[status];
}

export function selectLatestRun(
  task: Pick<IntegrationTaskSummary, "runs">,
): IntegrationRunSummary | undefined {
  return task.runs.reduce<IntegrationRunSummary | undefined>(
    (latest, run) =>
      !latest || run.sequence > latest.sequence ? run : latest,
    undefined,
  );
}

export function selectLatestStageRun(
  task: Pick<IntegrationTaskSummary, "runs">,
  stage: IntegrationStage,
): IntegrationRunSummary | undefined {
  return task.runs.reduce<IntegrationRunSummary | undefined>(
    (latest, run) =>
      run.stage === stage && (!latest || run.sequence > latest.sequence)
        ? run
        : latest,
    undefined,
  );
}

export function selectLatestArtifact(
  task: Pick<IntegrationTaskSummary, "runs">,
  type: IntegrationArtifactType,
): IntegrationArtifactSummary | undefined {
  return selectLatestArtifactRun(task, type)?.artifact;
}

export function selectLatestArtifactRun(
  task: Pick<IntegrationTaskSummary, "runs">,
  type: IntegrationArtifactType,
): {
  run: IntegrationRunSummary;
  artifact: IntegrationArtifactSummary;
} | undefined {
  let latest:
    | {
        run: IntegrationRunSummary;
        artifact: IntegrationArtifactSummary;
      }
    | undefined;
  for (const run of task.runs) {
    const artifact = run.artifacts.find((candidate) => candidate.type === type);
    if (artifact && (!latest || run.sequence > latest.run.sequence)) {
      latest = { run, artifact };
    }
  }
  return latest;
}

export function isAutomationActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function hasActiveIntegrationRuns(
  tasks: ReadonlyArray<
    Pick<IntegrationTaskSummary, "automationStatus" | "canRetry" | "canDelete">
  >,
): boolean {
  return tasks.some(
    (task) =>
      isAutomationActive(task.automationStatus) ||
      (task.automationStatus === "failed" && !task.canRetry) ||
      task.canDelete === false,
  );
}

export function unwrapApiItem<T>(value: T | { item: T }): T {
  if (
    value &&
    typeof value === "object" &&
    "item" in value &&
    (value as { item?: T }).item
  ) {
    return (value as { item: T }).item;
  }
  return value as T;
}

export function unwrapApiItems<T>(
  value: T[] | { items: T[] },
): T[] {
  return Array.isArray(value) ? value : value.items;
}

export interface IntegrationRevisionTracker {
  current(): number;
  advance(): number;
  isCurrent(revision: number): boolean;
}

export function createIntegrationRevisionTracker(): IntegrationRevisionTracker {
  let revision = 0;
  return {
    current: () => revision,
    advance: () => {
      revision += 1;
      return revision;
    },
    isCurrent: (candidate) => candidate === revision,
  };
}

export function resolveIntegrationFixedColumn(
  compact: boolean,
  edge: "left" | "right",
): "left" | "right" | undefined {
  return compact ? undefined : edge;
}
