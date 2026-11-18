"use client";

import {
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CodeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileProtectOutlined,
  FilterOutlined,
  MoreOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownMessage } from "@/features/chat-workbench/components/MarkdownMessage";
import { DataTable } from "@/shared/data-table/DataTable";
import { TimeRangeTabs } from "@/shared/time-range/TimeRangeTabs";
import { timeRangeStart, type TimeRangeId } from "@/contracts/time-range";
import {
  createIntegrationRevisionTracker,
  getStatusActions,
  isAutomationActive,
  resolveIntegrationFixedColumn,
  selectLatestArtifactRun,
  selectLatestRun,
  selectLatestStageRun,
  type IntegrationArtifactDetail,
  type IntegrationArtifactSummary,
  type IntegrationArtifactType,
  type IntegrationConflictCheckResult,
  type IntegrationProject,
  type IntegrationRunDetail,
  type IntegrationRunSummary,
  type IntegrationStage,
  type IntegrationStatusAction,
  type IntegrationTaskDetail,
  type IntegrationTaskStatus,
  type IntegrationTaskSummary,
} from "./types";
import { useIntegrationWorkbench } from "./useIntegrationWorkbench";
import styles from "./IntegrationWorkbench.module.css";

const { Text, Title } = Typography;

const STATUS_META: Record<
  IntegrationTaskStatus,
  { label: string; color: string }
> = {
  developing: { label: "开发中", color: "default" },
  submitted: { label: "已提测", color: "processing" },
  merge_pending: { label: "待合入", color: "warning" },
  merged: { label: "已合入", color: "success" },
  closed: { label: "已关闭", color: "default" },
};

const AUTOMATION_META: Record<
  string,
  { label: string; tone: "idle" | "active" | "success" | "failed" }
> = {
  idle: { label: "待命", tone: "idle" },
  queued: { label: "排队中", tone: "active" },
  running: { label: "执行中", tone: "active" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "执行失败", tone: "failed" },
};

const ARTIFACT_META: Record<
  IntegrationArtifactType,
  { label: string; shortLabel: string }
> = {
  initial_review: { label: "第一轮 Code Review", shortLabel: "首轮审查" },
  test_cases: { label: "分支测试用例", shortLabel: "测试用例" },
  final_review: { label: "合入前 Code Review", shortLabel: "合入审查" },
};

const ARTIFACT_STAGE: Record<IntegrationArtifactType, IntegrationStage> = {
  initial_review: "submit_review_and_tests",
  test_cases: "submit_review_and_tests",
  final_review: "pre_merge_review",
};

type CreateFormValues = {
  title: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  featureDesc?: string;
};

type ReportTarget = {
  taskId: string;
  runId: string;
  artifactType: IntegrationArtifactType;
};

function selectPreviousTerminalArtifactRun(
  task: Pick<IntegrationTaskSummary, "runs">,
  type: IntegrationArtifactType,
  latestRunId?: string,
): { run: IntegrationRunSummary; artifact: IntegrationArtifactSummary } | undefined {
  return task.runs.reduce<
    { run: IntegrationRunSummary; artifact: IntegrationArtifactSummary } | undefined
  >((latest, run) => {
    if (run.id === latestRunId) return latest;
    const artifact = run.artifacts.find(
      (candidate) =>
        candidate.type === type &&
        (candidate.status === "succeeded" || candidate.status === "failed"),
    );
    return artifact && (!latest || run.sequence > latest.run.sequence)
      ? { run, artifact }
      : latest;
  }, undefined);
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function abbreviateSha(value?: string | null): string {
  return value ? value.slice(0, 8) : "等待快照";
}

function taskMatches(
  task: IntegrationTaskSummary,
  keyword: string,
  status: string,
  automation: string,
  range: TimeRangeId,
): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();
  const text = [
    task.id,
    task.title,
    task.projectId,
    task.sourceBranch,
    task.targetBranch,
    task.creator?.personName || "",
  ]
    .join(" ")
    .toLowerCase();
  const since = timeRangeStart(range);
  return (
    (!normalizedKeyword || text.includes(normalizedKeyword)) &&
    (!status || task.status === status) &&
    (!automation || task.automationStatus === automation) &&
    (!since || new Date(task.updatedAt).getTime() >= since.getTime())
  );
}

function AutomationBadge({ status }: { status: string }) {
  const meta = AUTOMATION_META[status] || {
    label: status || "未知",
    tone: "idle" as const,
  };
  return (
    <span className={`${styles.automationBadge} ${styles[`automation_${meta.tone}`]}`}>
      {meta.tone === "active" ? <SyncOutlined spin /> : null}
      {meta.tone === "success" ? <CheckCircleFilled /> : null}
      {meta.tone === "failed" ? <CloseCircleFilled /> : null}
      {meta.tone === "idle" ? <ClockCircleOutlined /> : null}
      {meta.label}
    </span>
  );
}

function ArtifactCell({
  artifact,
  run,
  previousRun,
  type,
  rerunDisabled,
  rerunLoading,
  rerunTooltip,
  onOpen,
  onOpenPrevious,
  onRerun,
}: {
  artifact?: IntegrationArtifactSummary;
  run?: IntegrationRunSummary;
  previousRun?: IntegrationRunSummary;
  type: IntegrationArtifactType;
  rerunDisabled: boolean;
  rerunLoading: boolean;
  rerunTooltip: string;
  onOpen: () => void;
  onOpenPrevious?: () => void;
  onRerun: () => void;
}) {
  if (!artifact) {
    return (
      <span className={styles.artifactEmpty}>
        <span className={styles.statusPin} />
        未生成
      </span>
    );
  }

  const canOpen = artifact.status === "succeeded" || artifact.status === "failed";
  return (
    <div
      className={`${styles.artifactCard} ${styles[`artifact_${artifact.status}`] || ""}`}
    >
      <button
        type="button"
        className={styles.artifactReportButton}
        disabled={!canOpen}
        onClick={onOpen}
        aria-label={`查看${ARTIFACT_META[type].label}`}
      >
        <span className={styles.artifactTopline}>
          {artifact.status === "running" || artifact.status === "queued" ? (
            <SyncOutlined spin />
          ) : artifact.status === "succeeded" ? (
            <CheckCircleFilled />
          ) : (
            <CloseCircleFilled />
          )}
          {artifact.status === "queued"
            ? "排队中"
            : artifact.status === "running"
              ? "生成中"
              : artifact.status === "succeeded"
                ? "查看报告"
                : "查看失败"}
        </span>
        <span className={styles.artifactConclusion}>
          {artifact.conclusion || (artifact.status === "failed" ? "执行未完成" : "报告已归档")}
        </span>
      </button>
      <div className={styles.artifactActions}>
        <span className={styles.artifactRunLabel}>运行 #{run?.sequence || "—"}</span>
        <div className={styles.artifactActionButtons}>
          {previousRun && onOpenPrevious ? (
            <Button
              type="text"
              size="small"
              className={styles.previousReportButton}
              aria-label={`查看${ARTIFACT_META[type].label}上一版，运行 #${previousRun.sequence}`}
              onClick={onOpenPrevious}
            >
              查看上一版
            </Button>
          ) : null}
          <Tooltip title={rerunTooltip}>
            <span
              className={styles.rerunButtonWrap}
              tabIndex={rerunDisabled ? 0 : -1}
              role={rerunDisabled ? "note" : undefined}
              aria-label={rerunDisabled ? `重新运行不可用：${rerunTooltip}` : undefined}
            >
              <Button
                type="text"
                size="small"
                icon={<RedoOutlined />}
                loading={rerunLoading}
                disabled={rerunDisabled}
                className={styles.rerunButton}
                onClick={onRerun}
              >
                重新运行
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ConflictCheckCell({
  task,
  result,
  loading,
  onCheck,
}: {
  task: IntegrationTaskSummary;
  result?: IntegrationConflictCheckResult;
  loading: boolean;
  onCheck: () => void;
}) {
  if (task.status !== "merge_pending") {
    return (
      <span className={styles.artifactEmpty}>
        <span className={styles.statusPin} />
        待合入时检测
      </span>
    );
  }

  const resultLabel = result
    ? result.hasConflicts
      ? result.conflictPathCount > 0
        ? `有冲突 · ${result.conflictPathCount}`
        : "有冲突"
      : "无冲突"
    : "未检测";

  return (
    <div className={styles.conflictCheckCell}>
      <Tooltip title="手动检查最新开发分支与目标分支">
        <span>
          <Button
            size="small"
            loading={loading}
            disabled={loading}
            onClick={onCheck}
          >
            {result ? "重新检测" : "检测冲突"}
          </Button>
        </span>
      </Tooltip>
      <span
        className={`${styles.conflictResult} ${
          result?.hasConflicts
            ? styles.conflictResultConflicted
            : result
              ? styles.conflictResultClean
              : ""
        }`}
      >
        {result ? (
          result.hasConflicts ? <CloseCircleFilled /> : <CheckCircleFilled />
        ) : null}
        {resultLabel}
      </span>
    </div>
  );
}

function actionConfirmContent(action: IntegrationStatusAction) {
  if (action.automation === "submit") {
    return (
      <div className={styles.confirmCopy}>
        状态将更新为「已提测」，随后 OpenCode 会并行调用
        <code>harmony-branch-code-review</code> 和
        <code>harmony-branch-test-cases</code>。审查结论不会自动改变后续业务状态。
      </div>
    );
  }
  if (action.automation === "merge") {
    return (
      <div className={styles.confirmCopy}>
        状态将更新为「待合入」。如果代码快照与提测时一致，将直接复用首轮审查；有代码变更时，OpenCode 才会调用
        <code>harmony-branch-code-review</code> 完成合入前审查。进入待合入后，可随时在最后一列手动检测与目标分支是否冲突。
      </div>
    );
  }
  return `确认执行「${action.label}」？`;
}

export function IntegrationWorkbench({ active }: { active: boolean }) {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const compactTable = screens.md === false;
  const vm = useIntegrationWorkbench(active);
  const [createOpen, setCreateOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  useEffect(() => {
    if (!active) return;
    const id = new URLSearchParams(window.location.search).get("integrationTask");
    if (id && /^[a-zA-Z0-9_-]{1,120}$/.test(id)) setKeyword(id);
  }, [active]);
  const [statusFilter, setStatusFilter] = useState("");
  const [automationFilter, setAutomationFilter] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRangeId>("all");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportDetail, setReportDetail] =
    useState<IntegrationTaskDetail | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [reportNoteDirty, setReportNoteDirty] = useState(false);
  const [reportNoteSaving, setReportNoteSaving] = useState(false);
  const [rerunningStage, setRerunningStage] = useState<{
    taskId: string;
    stage: IntegrationStage;
  } | null>(null);
  const [conflictResults, setConflictResults] = useState<
    Record<string, IntegrationConflictCheckResult>
  >({});
  const [checkingConflictTasks, setCheckingConflictTasks] = useState<
    Record<string, true>
  >({});
  const conflictCheckRevisions = useRef(new Map<string, number>());
  const tableShellRef = useRef<HTMLDivElement>(null);
  const [tableBodyHeight, setTableBodyHeight] = useState(480);
  const reportRevisionTracker = useRef(createIntegrationRevisionTracker());
  const [form] = Form.useForm<CreateFormValues>();

  const projectMap = useMemo(
    () => new Map(vm.projects.map((project) => [project.id, project])),
    [vm.projects],
  );
  const visibleTasks = useMemo(
    () =>
      vm.tasks.filter((task) =>
        taskMatches(task, keyword, statusFilter, automationFilter, timeRange),
      ),
    [automationFilter, keyword, statusFilter, timeRange, vm.tasks],
  );
  useEffect(() => {
    const shell = tableShellRef.current;
    if (!shell || !active) return;
    const measure = () => {
      if (shell.clientHeight <= 0) return;
      const ledger = shell.querySelector(`.${styles.ledgerHeader}`)?.clientHeight ?? 40;
      const head = shell.querySelector(".ant-table-thead")?.clientHeight ?? 39;
      const pager = shell.querySelector(".ant-pagination")?.clientHeight ?? 0;
      setTableBodyHeight(Math.max(160, shell.clientHeight - ledger - head - pager - 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [active, visibleTasks.length]);

  const activeCount = vm.tasks.filter((task) =>
    isAutomationActive(task.automationStatus),
  ).length;
  const failedCount = vm.tasks.filter(
    (task) => task.automationStatus === "failed",
  ).length;
  const mergePendingCount = vm.tasks.filter(
    (task) => task.status === "merge_pending",
  ).length;

  function openCreate() {
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
  }

  function selectProject(projectId: string) {
    const project = projectMap.get(projectId);
    if (project) form.setFieldValue("targetBranch", project.defaultTargetBranch);
  }

  async function submitCreate() {
    try {
      const values = await form.validateFields();
      await vm.createTask(values);
      message.success("集成任务已创建");
      closeCreate();
    } catch (cause) {
      if (cause instanceof Error) message.error(cause.message);
    }
  }

  function confirmStatus(
    task: IntegrationTaskSummary,
    action: IntegrationStatusAction,
  ) {
    modal.confirm({
      title: action.label,
      content: task.id.startsWith('cloud-') && task.featureDesc?.includes('已通过云Agent独立代码审查与Harness交付门禁')
        ? action.status === 'submitted' ? '确认已拉取特性分支并完成本地复核与验收。同步转译任务提测状态，不重新执行转译或自动验收。' : '更新提测记录的业务状态，不重新执行转译。实际 MR 合入由后台独立核实。'
        : actionConfirmContent(action),
      okText: "确认执行",
      cancelText: "取消",
      okButtonProps: { danger: action.tone === "danger" },
      async onOk() {
        try {
          await vm.updateStatus(task, action.status);
          message.success(`任务状态已更新为${STATUS_META[action.status].label}`);
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "状态更新失败");
          throw cause;
        }
      },
    });
  }

  async function retry(task: IntegrationTaskSummary, run: IntegrationRunSummary) {
    try {
      await vm.retryRun(task, run);
      message.success("已创建新的自动化运行");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "重试失败");
    }
  }

  function confirmRerun(
    task: IntegrationTaskSummary,
    run: IntegrationRunSummary,
    type: IntegrationArtifactType,
  ) {
    const stage = ARTIFACT_STAGE[type];
    const rerunsReviewAndTests = stage === "submit_review_and_tests";
    modal.confirm({
      title: rerunsReviewAndTests ? "重新运行审查与测试用例？" : "重新运行合入前审查？",
      content: (
        <div className={styles.confirmCopy}>
          {rerunsReviewAndTests ? (
            <>
              将重新读取开发分支的最新代码，并同时生成<strong>第一轮审查</strong>和
              <strong>测试用例</strong>。现有报告会保留在历史运行中。
            </>
          ) : (
            <>
              将重新读取开发分支的最新代码并生成<strong>合入前审查</strong>。
              现有报告会保留在历史运行中。
            </>
          )}
        </div>
      ),
      okText: "重新运行",
      cancelText: "取消",
      async onOk() {
        setRerunningStage({ taskId: task.id, stage });
        try {
          await vm.rerunStage(task, stage, run.id);
          message.success(
            rerunsReviewAndTests
              ? "已重新运行第一轮审查和测试用例"
              : "已重新运行合入前审查",
          );
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "重新运行失败");
          throw cause;
        } finally {
          setRerunningStage(null);
        }
      },
    });
  }

  function confirmDelete(task: IntegrationTaskSummary) {
    modal.confirm({
      title: "删除任务？",
      content: (
        <div className={styles.confirmCopy}>
          任务「{task.title}」及其所有运行记录、审查报告和测试用例将被永久删除，删除后无法恢复。
        </div>
      ),
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      async onOk() {
        try {
          await vm.deleteTask(task);
          setConflictResults((current) => {
            const next = { ...current };
            delete next[task.id];
            return next;
          });
          conflictCheckRevisions.current.set(
            task.id,
            (conflictCheckRevisions.current.get(task.id) || 0) + 1,
          );
          setCheckingConflictTasks((current) => {
            const next = { ...current };
            delete next[task.id];
            return next;
          });
          if (reportTarget?.taskId === task.id) {
            closeReportImmediately();
            setReportDetail(null);
            setReportTarget(null);
          }
          message.success("任务已删除");
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "删除失败");
          throw cause;
        }
      },
    });
  }

  async function checkConflicts(task: IntegrationTaskSummary) {
    const revision = (conflictCheckRevisions.current.get(task.id) || 0) + 1;
    conflictCheckRevisions.current.set(task.id, revision);
    setCheckingConflictTasks((current) => ({ ...current, [task.id]: true }));
    try {
      const result = await vm.checkMergeConflicts(task.id);
      if (conflictCheckRevisions.current.get(task.id) !== revision) return;
      setConflictResults((current) => ({ ...current, [task.id]: result }));
      modal.info({
        title: result.hasConflicts
          ? result.conflictPathCount > 0
            ? `检测到 ${result.conflictPathCount} 个冲突文件`
            : "检测到合并冲突"
          : "未发现合并冲突",
        width: 620,
        okText: "我知道了",
        content: (
          <div className={styles.conflictModalContent}>
            <div className={styles.conflictModalMeta}>
              <span>
                开发分支 <code>{result.sourceBranch}</code>
              </span>
              <span>
                目标分支 <code>{result.targetBranch}</code>
              </span>
              <span>
                开发提交 <code>{abbreviateSha(result.headSha)}</code>
              </span>
              <span>
                目标提交 <code>{abbreviateSha(result.targetTipSha)}</code>
              </span>
              <span>检测时间 {formatTime(result.checkedAt)}</span>
            </div>
            {result.hasConflicts ? (
              <>
                <Alert
                  type="error"
                  showIcon
                  message="当前不建议直接合入，请先解决以下冲突"
                />
                {result.conflictPaths.length > 0 ? (
                  <ol className={styles.conflictPathList}>
                    {result.conflictPaths.map((filePath, index) => (
                      <li key={`${index}-${filePath}`}>
                        <code>{filePath}</code>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {result.conflictPathsTruncated ? (
                  <Text type="secondary">
                    {result.conflictPaths.length < result.conflictPathCount
                      ? `仅展示 ${result.conflictPaths.length} 个，共 ${result.conflictPathCount} 个冲突文件。`
                      : "部分过长文件路径已截断展示。"}
                  </Text>
                ) : null}
              </>
            ) : (
              <Alert
                type="success"
                showIcon
                message="当前开发分支与目标分支没有检测到合并冲突"
              />
            )}
          </div>
        ),
      });
    } catch (cause) {
      if (conflictCheckRevisions.current.get(task.id) === revision) {
        message.error(cause instanceof Error ? cause.message : "冲突检测失败");
      }
    } finally {
      if (conflictCheckRevisions.current.get(task.id) === revision) {
        setCheckingConflictTasks((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
    }
  }

  async function openReport(
    task: IntegrationTaskSummary,
    run: IntegrationRunSummary,
    artifactType: IntegrationArtifactType,
  ) {
    if (reportOpen && reportNoteSaving) return;
    if (reportOpen && !(await confirmDiscardReportNote())) return;
    const requestRevision = reportRevisionTracker.current.advance();
    setReportOpen(true);
    setReportLoading(true);
    setReportDetail(null);
    setReportNoteDirty(false);
    setReportTarget({ taskId: task.id, runId: run.id, artifactType });
    try {
      const detail = await vm.loadTaskDetail(task.id);
      if (reportRevisionTracker.current.isCurrent(requestRevision)) {
        setReportDetail(detail);
      }
    } catch (cause) {
      if (reportRevisionTracker.current.isCurrent(requestRevision)) {
        message.error(cause instanceof Error ? cause.message : "报告加载失败");
      }
    } finally {
      if (reportRevisionTracker.current.isCurrent(requestRevision)) {
        setReportLoading(false);
      }
    }
  }

  function closeReportImmediately() {
    reportRevisionTracker.current.advance();
    setReportNoteDirty(false);
    setReportNoteSaving(false);
    setReportOpen(false);
    setReportLoading(false);
  }

  async function confirmDiscardReportNote(): Promise<boolean> {
    if (!reportNoteDirty) return true;
    return modal.confirm({
      title: "放弃未保存的 Review 说明？",
      content: "当前输入尚未保存，离开后这些修改会丢失。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
    });
  }

  async function closeReport() {
    if (reportNoteSaving) return;
    if (!(await confirmDiscardReportNote())) return;
    closeReportImmediately();
  }

  async function selectReportTarget(next: Pick<ReportTarget, "runId" | "artifactType">) {
    if (reportNoteSaving) return;
    if (!(await confirmDiscardReportNote())) return;
    setReportNoteDirty(false);
    setReportTarget((current) => current ? { ...current, ...next } : current);
  }

  const reportRun = useMemo<IntegrationRunDetail | undefined>(() => {
    if (!reportDetail || !reportTarget) return undefined;
    return reportDetail.runs.find((run) => run.id === reportTarget.runId);
  }, [reportDetail, reportTarget]);

  async function saveReportNote(
    artifact: IntegrationArtifactDetail,
    note: string,
  ) {
    if (!reportTarget) throw new Error("报告目标已变化，请重新打开后再保存");
    const requestRevision = reportRevisionTracker.current.current();
    try {
      const detail = await vm.saveReviewNote(reportTarget.taskId, artifact.id, {
        note,
        expectedUpdatedAt: artifact.reviewNoteUpdatedAt,
      });
      if (reportRevisionTracker.current.isCurrent(requestRevision)) {
        setReportDetail(detail);
        setReportNoteDirty(false);
        message.success(note ? "Review 说明已保存" : "Review 说明已清空");
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "Review 说明保存失败");
      throw cause;
    }
  }

  const columns: ColumnsType<IntegrationTaskSummary> = [
    {
      title: "集成任务 / 分支",
      key: "task",
      sorter: (left, right) => left.title.localeCompare(right.title, "zh"),
      width: compactTable ? 220 : 248,
      fixed: resolveIntegrationFixedColumn(compactTable, "left"),
      render: (_, task) => (
        <div className={styles.taskCell}>
          <div className={styles.taskTitle}>{task.title}</div>
          <div className={styles.branchLine}>
            <BranchesOutlined />
            <Tooltip title={task.sourceBranch}>
              <code>{task.sourceBranch}</code>
            </Tooltip>
            <span>→</span>
            <Tooltip title={task.targetBranch}>
              <code>{task.targetBranch}</code>
            </Tooltip>
          </div>
          <div className={styles.taskMeta}>
            <span>{projectMap.get(task.projectId)?.label || task.projectId}</span>
            <span>·</span>
            <span>{task.creator?.personName || "未知创建人"}</span>
            <span>·</span>
            <span>{formatTime(task.updatedAt)}</span>
          </div>
        </div>
      ),
    },
    {
      title: "业务状态",
      key: "status",
      sorter: (left, right) =>
        STATUS_META[left.status].label.localeCompare(STATUS_META[right.status].label, "zh"),
      width: 142,
      render: (_, task) => {
        const actions = getStatusActions(task.status);
        const busy =
          vm.mutatingTaskId !== null ||
          isAutomationActive(task.automationStatus);
        return (
          <div className={styles.statusCell}>
            <Tag color={STATUS_META[task.status].color}>
              {STATUS_META[task.status].label}
            </Tag>
            {actions.length ? (
              <Dropdown
                disabled={busy}
                trigger={["click"]}
                menu={{
                  items: actions.map((action) => ({
                    key: action.status,
                    label: action.label,
                    danger: action.tone === "danger",
                  })),
                  onClick: ({ key }) => {
                    const action = actions.find((item) => item.status === key);
                    if (action) confirmStatus(task, action);
                  },
                }}
              >
                <Button
                  size="small"
                  loading={vm.mutatingTaskId === task.id}
                  disabled={busy}
                >
                  变更状态
                </Button>
              </Dropdown>
            ) : (
              <span className={styles.terminalLabel}>流程已结束</span>
            )}
          </div>
        );
      },
    },
    {
      title: "自动化",
      key: "automation",
      sorter: (left, right) => left.automationStatus.localeCompare(right.automationStatus, "zh"),
      width: 132,
      render: (_, task) => {
        const run = selectLatestRun(task);
        return (
          <div className={styles.automationCell}>
            <AutomationBadge status={task.automationStatus} />
            <span className={styles.shaLabel}>
              {run ? `#${run.sequence} · ${abbreviateSha(run.headSha)}` : "暂无运行"}
            </span>
            {task.automationStatus === "failed" && run ? (
              <Tooltip
                title={
                  task.canRetry
                    ? "重新执行本阶段自动化"
                    : task.retryBlockedReason || "隔离资源正在安全清理，完成后可重试"
                }
              >
                <span className={styles.retryButtonWrap}>
                  <Button
                    danger
                    type="link"
                    size="small"
                    className={styles.retryButton}
                    disabled={!task.canRetry || vm.mutatingTaskId !== null}
                    onClick={() => void retry(task, run)}
                  >
                    {task.canRetry ? "失败重试" : "清理中，暂不可重试"}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      title: "第一轮审查",
      key: "initial_review",
      sorter: (left, right) =>
        (selectLatestArtifactRun(left, "initial_review")?.artifact.status || "").localeCompare(
          selectLatestArtifactRun(right, "initial_review")?.artifact.status || "",
          "zh",
        ),
      width: 168,
      render: (_, task) => {
        const result = selectLatestArtifactRun(task, "initial_review");
        const previousResult = result &&
          (result.artifact.status === "queued" || result.artifact.status === "running")
          ? selectPreviousTerminalArtifactRun(task, "initial_review", result.run.id)
          : undefined;
        const stage = ARTIFACT_STAGE.initial_review;
        const stageRun = selectLatestStageRun(task, stage);
        const active = isAutomationActive(task.automationStatus);
        const canRerun = task.rerunnableStages.includes(stage);
        const mutationBusy = vm.mutatingTaskId !== null;
        return (
          <ArtifactCell
            artifact={result?.artifact}
            run={result?.run}
            previousRun={previousResult?.run}
            type="initial_review"
            rerunDisabled={!stageRun || !canRerun || active || mutationBusy}
            rerunLoading={
              rerunningStage?.taskId === task.id && rerunningStage.stage === stage
            }
            rerunTooltip={
              active
                ? "当前自动化完成后可重新运行"
                : mutationBusy
                  ? "另一项任务操作正在处理"
                  : canRerun
                    ? "重新生成第一轮审查和测试用例"
                    : task.rerunBlockedReason || "当前阶段暂不可重新运行"
            }
            onOpen={() =>
              result && void openReport(task, result.run, "initial_review")
            }
            onOpenPrevious={previousResult
              ? () => void openReport(task, previousResult.run, "initial_review")
              : undefined}
            onRerun={() => stageRun && confirmRerun(task, stageRun, "initial_review")}
          />
        );
      },
    },
    {
      title: "测试用例",
      key: "test_cases",
      sorter: (left, right) =>
        (selectLatestArtifactRun(left, "test_cases")?.artifact.status || "").localeCompare(
          selectLatestArtifactRun(right, "test_cases")?.artifact.status || "",
          "zh",
        ),
      width: 168,
      render: (_, task) => {
        const result = selectLatestArtifactRun(task, "test_cases");
        const previousResult = result &&
          (result.artifact.status === "queued" || result.artifact.status === "running")
          ? selectPreviousTerminalArtifactRun(task, "test_cases", result.run.id)
          : undefined;
        const stage = ARTIFACT_STAGE.test_cases;
        const stageRun = selectLatestStageRun(task, stage);
        const active = isAutomationActive(task.automationStatus);
        const canRerun = task.rerunnableStages.includes(stage);
        const mutationBusy = vm.mutatingTaskId !== null;
        return (
          <ArtifactCell
            artifact={result?.artifact}
            run={result?.run}
            previousRun={previousResult?.run}
            type="test_cases"
            rerunDisabled={!stageRun || !canRerun || active || mutationBusy}
            rerunLoading={
              rerunningStage?.taskId === task.id && rerunningStage.stage === stage
            }
            rerunTooltip={
              active
                ? "当前自动化完成后可重新运行"
                : mutationBusy
                  ? "另一项任务操作正在处理"
                  : canRerun
                    ? "重新生成第一轮审查和测试用例"
                    : task.rerunBlockedReason || "当前阶段暂不可重新运行"
            }
            onOpen={() =>
              result && void openReport(task, result.run, "test_cases")
            }
            onOpenPrevious={previousResult
              ? () => void openReport(task, previousResult.run, "test_cases")
              : undefined}
            onRerun={() => stageRun && confirmRerun(task, stageRun, "test_cases")}
          />
        );
      },
    },
    {
      title: "合入前审查",
      key: "final_review",
      sorter: (left, right) =>
        (selectLatestArtifactRun(left, "final_review")?.artifact.status || "").localeCompare(
          selectLatestArtifactRun(right, "final_review")?.artifact.status || "",
          "zh",
        ),
      width: 168,
      render: (_, task) => {
        const result = selectLatestArtifactRun(task, "final_review");
        const previousResult = result &&
          (result.artifact.status === "queued" || result.artifact.status === "running")
          ? selectPreviousTerminalArtifactRun(task, "final_review", result.run.id)
          : undefined;
        const stage = ARTIFACT_STAGE.final_review;
        const stageRun = selectLatestStageRun(task, stage);
        const active = isAutomationActive(task.automationStatus);
        const canRerun = task.rerunnableStages.includes(stage);
        const mutationBusy = vm.mutatingTaskId !== null;
        return (
          <ArtifactCell
            artifact={result?.artifact}
            run={result?.run}
            previousRun={previousResult?.run}
            type="final_review"
            rerunDisabled={!stageRun || !canRerun || active || mutationBusy}
            rerunLoading={
              rerunningStage?.taskId === task.id && rerunningStage.stage === stage
            }
            rerunTooltip={
              active
                ? "当前自动化完成后可重新运行"
                : mutationBusy
                  ? "另一项任务操作正在处理"
                  : canRerun
                    ? "重新生成合入前审查"
                    : task.rerunBlockedReason || "当前阶段暂不可重新运行"
            }
            onOpen={() =>
              result && void openReport(task, result.run, "final_review")
            }
            onOpenPrevious={previousResult
              ? () => void openReport(task, previousResult.run, "final_review")
              : undefined}
            onRerun={() => stageRun && confirmRerun(task, stageRun, "final_review")}
          />
        );
      },
    },
    {
      title: "冲突检测",
      key: "manual_conflict_check",
      width: 168,
      render: (_, task) => (
        <ConflictCheckCell
          task={task}
          result={conflictResults[task.id]}
          loading={Boolean(checkingConflictTasks[task.id])}
          onCheck={() => void checkConflicts(task)}
        />
      ),
    },
    {
      title: "",
      key: "more",
      width: 50,
      fixed: resolveIntegrationFixedColumn(compactTable, "right"),
      render: (_, task) => (
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              {
                key: "refresh",
                label: "刷新任务",
                icon: <ReloadOutlined />,
              },
              { type: "divider" },
              {
                key: "delete",
                label: (
                  <Tooltip title={task.canDelete ? undefined : task.deleteBlockedReason}>
                    <span
                      aria-label={
                        task.canDelete
                          ? "删除任务"
                          : `删除任务：${task.deleteBlockedReason || "执行结束后可用"}`
                      }
                    >
                      删除任务
                    </span>
                  </Tooltip>
                ),
                icon: <DeleteOutlined />,
                danger: true,
                disabled: !task.canDelete,
              },
            ],
            onClick: ({ key }) => {
              if (key === "refresh") {
                void vm.refreshTasks();
                return;
              }
              if (key === "delete") confirmDelete(task);
            },
          }}
        >
          <Button
            type="text"
            icon={<MoreOutlined />}
            loading={vm.mutatingTaskId === task.id}
            disabled={vm.mutatingTaskId !== null}
            aria-label={`任务 ${task.title} 的更多操作`}
          />
        </Dropdown>
      ),
    },
  ];

  const reportTabs = (
    ["initial_review", "test_cases", "final_review"] as IntegrationArtifactType[]
  ).map((type) => {
    const artifact = reportRun?.artifacts.find((item) => item.type === type);
    return {
      key: type,
      label: ARTIFACT_META[type].shortLabel,
      disabled: !artifact,
      children: (
        <ReportPanel
          artifact={artifact}
          run={reportRun}
          taskTitle={reportDetail?.title}
          loading={reportLoading}
          mutationBusy={vm.mutatingTaskId !== null}
          onDirtyChange={setReportNoteDirty}
          onSavingChange={setReportNoteSaving}
          onSaveNote={saveReportNote}
        />
      ),
    };
  });

  return (
    <div className={styles.root}>
      <header className={styles.commandBar}>
        <div>
          <div className={styles.eyebrow}>
            HARMONY DELIVERY OPS <span>／</span> INTEGRATION CONTROL DECK
          </div>
          <Title level={2} className={styles.pageTitle}>
            鸿蒙集成工作台
          </Title>
          <Text className={styles.pageSubtitle}>
            把分支流转、审查报告与测试清单收拢为一条可追溯的合入流水线
          </Text>
        </div>
        <div className={styles.metrics} aria-label="集成任务概览">
          <Metric value={vm.tasks.length} label="总任务" hint="全部任务" tone="neutral" />
          <Metric value={activeCount} label="执行" hint="AI 正在执行" tone="teal" />
          <Metric value={mergePendingCount} label="待合入" hint="等待合入" tone="amber" />
          <Metric value={failedCount} label="待处理" hint="需要处理" tone="red" />
        </div>
      </header>

      <section className={styles.workspace}>
        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <Input
              allowClear
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              prefix={<FilterOutlined />}
              placeholder="任务、项目或分支"
              className={styles.searchInput}
            />
            <Select
              allowClear
              value={statusFilter || undefined}
              onChange={(value) => setStatusFilter(value || "")}
              placeholder="业务状态"
              className={styles.filterSelect}
              options={Object.entries(STATUS_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
            />
            <Select
              allowClear
              value={automationFilter || undefined}
              onChange={(value) => setAutomationFilter(value || "")}
              placeholder="自动化状态"
              className={styles.filterSelect}
              options={Object.entries(AUTOMATION_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
            />
            <TimeRangeTabs value={timeRange} onChange={setTimeRange} />
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={vm.loading}
              onClick={() => void vm.refreshTasks()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              className={styles.createButton}
              onClick={openCreate}
            >
              新建集成任务
            </Button>
          </Space>
        </div>

        {vm.error ? (
          <Alert
            type="error"
            showIcon
            closable
            message={vm.error}
            className={styles.errorAlert}
            onClose={vm.clearError}
          />
        ) : null}

        <div className={styles.tableShell} ref={tableShellRef} data-empty={visibleTasks.length === 0}>
          <div className={styles.ledgerHeader}>
            <div>
              <SafetyCertificateOutlined />
              集成流水账
            </div>
            <span>状态由人推进，审查结论仅提供决策依据</span>
          </div>
          <DataTable
            tableKey="integration-ledger"
            rowKey="id"
            columns={columns}
            dataSource={visibleTasks}
            loading={vm.loading && !vm.tasks.length}
            pagination={{
              pageSize: 12,
              hideOnSinglePage: true,
              showSizeChanger: false,
            }}
            scroll={visibleTasks.length > 0 ? { y: tableBodyHeight } : undefined}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有匹配的集成任务"
                >
                  <Button type="primary" onClick={openCreate}>
                    创建第一条任务
                  </Button>
                </Empty>
              ),
            }}
            rowClassName={(task) =>
              task.automationStatus === "failed" ? styles.failedRow : ""
            }
          />
        </div>
      </section>

      <Modal
        title={
          <div className={styles.modalTitle}>
            <CodeOutlined />
            建立分支集成任务
          </div>
        }
        open={createOpen}
        width={640}
        okText="创建任务"
        cancelText="取消"
        confirmLoading={vm.creating}
        onOk={() => void submitCreate()}
        onCancel={closeCreate}
        destroyOnHidden
      >
        <div className={styles.modalIntro}>
          创建后保持「开发中」。驻场提测时再推进状态，由 OpenCode 执行对应技能。
        </div>
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          clearOnDestroy
        >
          <Form.Item
            name="title"
            label="任务名称"
            rules={[{ required: true, message: "请输入任务名称" }]}
          >
            <Input maxLength={200} placeholder="例如：KTV 点歌面板横屏适配" />
          </Form.Item>
          <div className={styles.formGrid}>
            <Form.Item
              name="projectId"
              label="项目"
              rules={[{ required: true, message: "请选择项目" }]}
            >
              <Select
                placeholder="选择有访问权限的项目"
                onChange={selectProject}
                options={vm.projects.filter(project => project.selectable !== false).map((project: IntegrationProject) => ({
                  value: project.id,
                  label: project.label,
                }))}
              />
            </Form.Item>
            <Form.Item name="targetBranch" label="目标分支" rules={[{ required: true }]}>
              <Input placeholder="请输入目标分支" />
            </Form.Item>
          </div>
          <Form.Item
            name="sourceBranch"
            label="开发分支"
            rules={[{ required: true, message: "请输入开发分支" }]}
          >
            <Input prefix={<BranchesOutlined />} placeholder="feature/your-branch" />
          </Form.Item>
          <Form.Item name="featureDesc" label="改动说明（可选）">
            <Input.TextArea
              rows={4}
              maxLength={4000}
              showCount
              placeholder="补充需求背景、重点路径或测试注意事项，帮助 AI 更准确地理解改动。"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={reportOpen}
        onClose={() => void closeReport()}
        maskClosable={!reportNoteSaving}
        keyboard={!reportNoteSaving}
        closable={!reportNoteSaving}
        width="min(860px, 94vw)"
        className={styles.reportDrawer}
        title={
          <div className={styles.drawerTitle}>
            <FileProtectOutlined />
            <span>
              {reportDetail?.title || "自动化报告"}
              <small>
                运行 #{reportRun?.sequence || "—"} ·{" "}
                {abbreviateSha(reportRun?.headSha)}
              </small>
            </span>
          </div>
        }
      >
        <div className={styles.reportRunPicker}>
          <span>运行历史</span>
          <Select
            value={reportTarget?.runId}
            disabled={reportLoading || !reportDetail || reportNoteSaving}
            aria-label="选择历史运行"
            onChange={(runId) => {
              const run = reportDetail?.runs.find((candidate) => candidate.id === runId);
              if (!run) return;
              const keepsCurrentType = run.artifacts.some(
                (artifact) => artifact.type === reportTarget?.artifactType,
              );
              const artifactType = keepsCurrentType
                ? reportTarget!.artifactType
                : run.artifacts[0]?.type as IntegrationArtifactType | undefined;
              if (artifactType) void selectReportTarget({ runId, artifactType });
            }}
            options={(reportDetail?.runs || []).map((run) => ({
              value: run.id,
              label: `运行 #${run.sequence} · ${AUTOMATION_META[run.status]?.label || run.status} · ${abbreviateSha(run.headSha)}`,
            }))}
          />
          <Text type="secondary">每次重跑都会保留独立报告和 Review 说明</Text>
        </div>
        <Tabs
          destroyOnHidden
          activeKey={reportTarget?.artifactType}
          tabBarStyle={reportNoteSaving ? { pointerEvents: "none", opacity: 0.62 } : undefined}
          onChange={(artifactType) => {
            if (!reportTarget) return;
            void selectReportTarget({
              runId: reportTarget.runId,
              artifactType: artifactType as IntegrationArtifactType,
            });
          }}
          items={reportTabs}
        />
      </Drawer>
    </div>
  );
}

function Metric({
  value,
  label,
  hint,
  tone,
}: {
  value: number;
  label: string;
  hint: string;
  tone: "neutral" | "teal" | "amber" | "red";
}) {
  return (
    <span className={`${styles.metric} ${styles[`metric_${tone}`]}`} title={hint}>
      <span>{label}</span>
      <strong>{value.toString().padStart(2, "0")}</strong>
    </span>
  );
}

function ReportPanel({
  artifact,
  run,
  taskTitle,
  loading,
  mutationBusy,
  onDirtyChange,
  onSavingChange,
  onSaveNote,
}: {
  artifact?: IntegrationArtifactDetail;
  run?: IntegrationRunDetail;
  taskTitle?: string;
  loading: boolean;
  mutationBusy: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onSaveNote: (
    artifact: IntegrationArtifactDetail,
    note: string,
  ) => Promise<void>;
}) {
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const canEditReviewNote =
    artifact?.status === "succeeded" &&
    (artifact.type === "initial_review" || artifact.type === "final_review");
  const savedNote = artifact?.reviewNote || "";
  const noteChanged = noteDraft !== savedNote;

  useEffect(() => {
    onDirtyChange(Boolean(canEditReviewNote && noteChanged));
    return () => onDirtyChange(false);
  }, [canEditReviewNote, noteChanged, onDirtyChange]);

  useEffect(() => {
    onSavingChange(savingNote);
    return () => onSavingChange(false);
  }, [onSavingChange, savingNote]);

  useEffect(() => {
    setNoteDraft(artifact?.reviewNote || "");
  }, [artifact?.id, artifact?.reviewNote]);

  if (loading) {
    return <div className={styles.reportLoading}>正在读取归档报告…</div>;
  }
  if (!artifact) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次运行未生成该报告" />;
  }
  const currentArtifact = artifact;

  const noteInputDisabled = savingNote || mutationBusy;

  async function persistNote(note: string) {
    setSavingNote(true);
    try {
      await onSaveNote(currentArtifact, note);
    } finally {
      setSavingNote(false);
    }
  }

  async function clearNote() {
    if (!savedNote) {
      setNoteDraft("");
      return;
    }
    await persistNote("");
  }

  function downloadTestCases() {
    if (currentArtifact.type !== "test_cases" || !currentArtifact.content?.trim() || !run) return;
    const safeTitle = (taskTitle || "集成任务")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
      .trim()
      .slice(0, 80) || "集成任务";
    const blob = new Blob([currentArtifact.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeTitle}-测试用例-运行${run.sequence}.md`;
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  return (
    <div className={styles.reportPanel}>
      <div className={styles.reportMeta}>
        <AutomationBadge status={artifact.status} />
        <span>开始：{formatTime(artifact.startedAt)}</span>
        <span>完成：{formatTime(artifact.finishedAt)}</span>
        <span>Diff：{abbreviateSha(run?.diffHash)}</span>
      </div>
      {artifact.error ? (
        <Alert
          type="error"
          showIcon
          message={artifact.errorCode || "自动化执行失败"}
          description={artifact.error}
        />
      ) : null}
      {canEditReviewNote ? (
        <section className={styles.reviewNoteCard} aria-label="Review 说明">
          <div className={styles.reviewNoteHeader}>
            <div>
              <strong>Review 说明</strong>
              <span>人工补充判断，不会改写下方 AI 原始报告</span>
            </div>
            {artifact.reviewNoteUpdatedAt ? (
              <small>
                {artifact.reviewNoteUpdatedBy || "未知用户"} · {formatTime(artifact.reviewNoteUpdatedAt)}
              </small>
            ) : (
              <small>尚未填写</small>
            )}
          </div>
          <Input.TextArea
            value={noteDraft}
            rows={4}
            maxLength={4000}
            showCount
            disabled={noteInputDisabled}
            placeholder="例如：该问题经核对不是缺陷，原因是……；或补充修复方案、风险判断与验证结果。"
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className={styles.reviewNoteActions}>
            <Text type="secondary">说明独立归档，原始审查结论保持不变</Text>
            <Space size={8}>
              <Popconfirm
                title="清空 Review 说明？"
                description="清空后仍可重新填写。"
                okText="清空"
                cancelText="取消"
                disabled={noteInputDisabled || (!savedNote && !noteDraft)}
                onConfirm={clearNote}
              >
                <Button
                  size="small"
                  disabled={noteInputDisabled || (!savedNote && !noteDraft)}
                >
                  清空说明
                </Button>
              </Popconfirm>
              <Button
                type="primary"
                size="small"
                loading={savingNote}
                disabled={!noteChanged || noteInputDisabled}
                onClick={() => void persistNote(noteDraft)}
              >
                保存说明
              </Button>
            </Space>
          </div>
        </section>
      ) : null}
      {artifact.content ? (
        <section className={styles.originalReportSection}>
          <div className={styles.originalReportHeader}>
            <span>AI 原始报告</span>
            <Space size={8}>
              <small>只读 · 运行 #{run?.sequence || "—"}</small>
              {artifact.type === "test_cases" ? (
                <Tooltip title="下载 Markdown 文件">
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!artifact.content.trim() || !run}
                    onClick={downloadTestCases}
                  >
                    下载测试用例
                  </Button>
                </Tooltip>
              ) : null}
            </Space>
          </div>
          <div className={styles.markdownSurface}>
            <MarkdownMessage content={artifact.content} />
          </div>
        </section>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={artifact.status === "failed" ? "本次运行没有可用报告" : "报告内容尚未归档"}
        />
      )}
    </div>
  );
}
