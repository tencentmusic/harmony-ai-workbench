"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createIntegrationRevisionTracker,
  hasActiveIntegrationRuns,
  selectLatestRun,
  unwrapApiItem,
  unwrapApiItems,
  type IntegrationConflictCheckResult,
  type IntegrationProject,
  type IntegrationRunSummary,
  type IntegrationStage,
  type IntegrationTaskDetail,
  type IntegrationTaskStatus,
  type IntegrationTaskSummary,
} from "./types";
import {
  IntegrationUnauthorizedError,
  requestIntegrationJson,
} from "./integration-http-client";

const POLL_INTERVAL_MS = 2_000;

type CreateTaskInput = {
  title: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  featureDesc?: string;
};

function describeRerunError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "RERUN_STAGE_NOT_ALLOWED") {
    return "任务业务状态已变化，当前阶段不能重新运行";
  }
  if (code === "RUN_ACTIVE") {
    return "当前已有自动化正在执行，请完成后再重新运行";
  }
  if (code === "RUN_CLEANUP_PENDING") {
    return "上一轮隔离资源仍在清理，请稍后再重新运行";
  }
  if (code === "RUN_CAS_CONFLICT") {
    return "运行记录已更新，请刷新任务后再重新运行";
  }
  if (code === "RUN_NOT_FOUND") {
    return "没有找到可重新运行的阶段记录";
  }
  return code || "自动化阶段重新运行失败";
}

function describeReviewNoteError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "REVIEW_NOTE_CAS_CONFLICT") {
    return "Review 说明已被其他人更新，请重新打开报告后再编辑";
  }
  if (code === "ARTIFACT_NOT_REVIEW") {
    return "当前报告不支持填写 Review 说明";
  }
  if (code === "ARTIFACT_NOT_SUCCEEDED") {
    return "Review 报告成功归档后才能填写说明";
  }
  if (code === "ARTIFACT_NOT_FOUND") {
    return "Review 报告已变化，请重新打开后再编辑";
  }
  return code || "Review 说明保存失败";
}

export function useIntegrationWorkbench(enabled: boolean) {
  const [tasks, setTasks] = useState<IntegrationTaskSummary[]>([]);
  const [projects, setProjects] = useState<IntegrationProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [authInvalid, setAuthInvalid] = useState(false);
  const authInvalidRef = useRef(false);
  const refreshInFlight = useRef(false);
  const taskMutationInFlight = useRef(false);
  const taskRevisionTracker = useRef(createIntegrationRevisionTracker());
  const replaceTask = useCallback((task: IntegrationTaskSummary) => {
    setTasks((current) => [
      task,
      ...current.filter((item) => item.id !== task.id),
    ]);
  }, []);
  const commitTaskMutation = useCallback(
    (task: IntegrationTaskSummary) => {
      taskRevisionTracker.current.advance();
      replaceTask(task);
    },
    [replaceTask],
  );
  const commitTaskDeletion = useCallback((taskId: string) => {
    taskRevisionTracker.current.advance();
    setTasks((current) => current.filter((task) => task.id !== taskId));
  }, []);
  const beginTaskMutation = useCallback((taskId: string) => {
    if (taskMutationInFlight.current) {
      throw new Error("另一项任务操作正在处理，请稍候");
    }
    taskMutationInFlight.current = true;
    setMutatingTaskId(taskId);
  }, []);
  const finishTaskMutation = useCallback(() => {
    taskMutationInFlight.current = false;
    setMutatingTaskId(null);
  }, []);
  const handleUnauthorized = useCallback(() => {
    if (authInvalidRef.current) return;
    authInvalidRef.current = true;
    setAuthInvalid(true);
    localStorage.removeItem("hm_token");
    window.location.replace("/login");
  }, []);

  const requestJson = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<T> => {
      return requestIntegrationJson<T>(url, init, {
        token: localStorage.getItem("hm_token") || "",
        onUnauthorized: handleUnauthorized,
      });
    },
    [handleUnauthorized],
  );

  const refreshTasks = useCallback(
    async (quiet = false) => {
      if (authInvalidRef.current || refreshInFlight.current) return;
      refreshInFlight.current = true;
      const requestRevision = taskRevisionTracker.current.current();
      if (!quiet) setLoading(true);
      try {
        const payload = await requestJson<
          IntegrationTaskSummary[] | { items: IntegrationTaskSummary[] }
        >("/api/integration/tasks");
        if (
          !authInvalidRef.current &&
          taskRevisionTracker.current.isCurrent(requestRevision)
        ) {
          setTasks(unwrapApiItems(payload));
          setError("");
        }
      } catch (cause) {
        if (
          !authInvalidRef.current &&
          !(cause instanceof IntegrationUnauthorizedError) &&
          taskRevisionTracker.current.isCurrent(requestRevision)
        ) {
          setError(
            cause instanceof Error ? cause.message : "集成任务列表加载失败",
          );
        }
      } finally {
        refreshInFlight.current = false;
        if (!quiet) setLoading(false);
      }
    },
    [requestJson],
  );

  const loadProjects = useCallback(async () => {
    if (authInvalidRef.current) return;
    try {
      const payload = await requestJson<
        IntegrationProject[] | { items: IntegrationProject[] }
      >("/api/integration/projects");
      if (!authInvalidRef.current) {
        setProjects(unwrapApiItems(payload));
      }
    } catch (cause) {
      if (!(cause instanceof IntegrationUnauthorizedError)) {
        setError(cause instanceof Error ? cause.message : "项目配置加载失败");
      }
    }
  }, [requestJson]);

  useEffect(() => {
    if (!enabled || authInvalid) return;
    void Promise.all([refreshTasks(), loadProjects()]);
  }, [authInvalid, enabled, loadProjects, refreshTasks]);

  const hasActiveRuns = useMemo(
    () => hasActiveIntegrationRuns(tasks),
    [tasks],
  );

  useEffect(() => {
    if (!enabled || !hasActiveRuns) return;
    if (authInvalid) return;
    const timer = window.setInterval(() => {
      if (!authInvalidRef.current) void refreshTasks(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [authInvalid, enabled, hasActiveRuns, refreshTasks]);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      setCreating(true);
      try {
        const payload = await requestJson<
          IntegrationTaskSummary | { item: IntegrationTaskSummary }
        >("/api/integration/tasks", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const task = unwrapApiItem(payload);
        commitTaskMutation(task);
        setError("");
        return task;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "创建集成任务失败";
        setError(message);
        throw new Error(message);
      } finally {
        setCreating(false);
      }
    },
    [commitTaskMutation, requestJson],
  );

  const updateStatus = useCallback(
    async (task: IntegrationTaskSummary, status: IntegrationTaskStatus) => {
      beginTaskMutation(task.id);
      try {
        const payload = await requestJson<
          IntegrationTaskSummary | { item: IntegrationTaskSummary }
        >(`/api/integration/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedStatus: task.status,
            status,
          }),
        });
        commitTaskMutation(unwrapApiItem(payload));
        setError("");
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "任务状态更新失败";
        setError(message);
        throw new Error(message);
      } finally {
        finishTaskMutation();
      }
    },
    [beginTaskMutation, commitTaskMutation, finishTaskMutation, requestJson],
  );

  const retryRun = useCallback(
    async (task: IntegrationTaskSummary, run?: IntegrationRunSummary) => {
      const targetRun = run || selectLatestRun(task);
      if (!targetRun) throw new Error("当前任务没有可重试的运行记录");
      beginTaskMutation(task.id);
      try {
        const payload = await requestJson<
          IntegrationTaskSummary | { item: IntegrationTaskSummary }
        >(`/api/integration/tasks/${task.id}/retry`, {
          method: "POST",
          body: JSON.stringify({ expectedRunId: targetRun.id }),
        });
        commitTaskMutation(unwrapApiItem(payload));
        setError("");
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "自动化任务重试失败";
        setError(message);
        throw new Error(message);
      } finally {
        finishTaskMutation();
      }
    },
    [beginTaskMutation, commitTaskMutation, finishTaskMutation, requestJson],
  );

  const rerunStage = useCallback(
    async (
      task: IntegrationTaskSummary,
      stage: IntegrationStage,
      expectedRunId: string,
    ) => {
      beginTaskMutation(task.id);
      try {
        const payload = await requestJson<
          IntegrationTaskSummary | { item: IntegrationTaskSummary }
        >(`/api/integration/tasks/${task.id}/rerun`, {
          method: "POST",
          body: JSON.stringify({ stage, expectedRunId }),
        });
        const updatedTask = unwrapApiItem(payload);
        commitTaskMutation(updatedTask);
        setError("");
        return updatedTask;
      } catch (cause) {
        const message = describeRerunError(cause);
        setError(message);
        throw new Error(message);
      } finally {
        finishTaskMutation();
      }
    },
    [beginTaskMutation, commitTaskMutation, finishTaskMutation, requestJson],
  );

  const deleteTask = useCallback(
    async (task: IntegrationTaskSummary) => {
      beginTaskMutation(task.id);
      try {
        await requestJson<null>(`/api/integration/tasks/${task.id}`, {
          method: "DELETE",
        });
        commitTaskDeletion(task.id);
        setError("");
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        const message = code === "TASK_DELETE_BLOCKED"
          ? "自动化执行或隔离资源清理完成后才能删除"
          : code === "TASK_NOT_FOUND"
            ? "任务不存在或已被删除"
            : code || "删除集成任务失败";
        setError(message);
        throw new Error(message);
      } finally {
        finishTaskMutation();
      }
    },
    [beginTaskMutation, commitTaskDeletion, finishTaskMutation, requestJson],
  );

  const loadTaskDetail = useCallback(
    async (taskId: string) => {
      const payload = await requestJson<
        IntegrationTaskDetail | { item: IntegrationTaskDetail }
      >(`/api/integration/tasks/${taskId}`);
      return unwrapApiItem(payload);
    },
    [requestJson],
  );

  const saveReviewNote = useCallback(
    async (
      taskId: string,
      artifactId: string,
      input: { note: string; expectedUpdatedAt: string | null },
    ) => {
      beginTaskMutation(taskId);
      try {
        const payload = await requestJson<
          IntegrationTaskDetail | { item: IntegrationTaskDetail }
        >(`/api/integration/tasks/${taskId}/artifacts/${artifactId}/note`, {
          method: "PATCH",
          body: JSON.stringify(input),
        });
        const detail = unwrapApiItem(payload);
        commitTaskMutation(detail);
        setError("");
        return detail;
      } catch (cause) {
        const message = describeReviewNoteError(cause);
        setError(message);
        throw new Error(message);
      } finally {
        finishTaskMutation();
      }
    },
    [beginTaskMutation, commitTaskMutation, finishTaskMutation, requestJson],
  );

  const checkMergeConflicts = useCallback(
    async (taskId: string) => {
      try {
        const payload = await requestJson<
          IntegrationConflictCheckResult | { item: IntegrationConflictCheckResult }
        >(`/api/integration/tasks/${taskId}/conflicts`, {
          method: "POST",
        });
        setError("");
        return unwrapApiItem(payload);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        const message = code === "MERGE_CONFLICT_CHECK_FAILED"
          ? "冲突检测失败，请检查分支或稍后重试"
          : code === "CONFLICT_CHECK_NOT_ALLOWED"
            ? "仅待合入任务可执行冲突检测"
            : code === "CONFLICT_CHECK_BUSY"
              ? "当前冲突检测任务较多，请稍后重试"
            : code === "PROJECT_NOT_FOUND"
              ? "集成项目未配置，无法检测冲突"
              : code || "冲突检测失败";
        setError(message);
        throw new Error(message);
      }
    },
    [requestJson],
  );

  return {
    tasks,
    projects,
    loading,
    creating,
    mutatingTaskId,
    error,
    clearError: () => setError(""),
    refreshTasks,
    createTask,
    updateStatus,
    retryRun,
    rerunStage,
    deleteTask,
    loadTaskDetail,
    saveReviewNote,
    checkMergeConflicts,
  };
}
