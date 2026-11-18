import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const requiredFiles = [
  "src/features/integration-workbench/types.ts",
  "src/features/integration-workbench/integration-http-client.ts",
  "src/features/integration-workbench/useIntegrationWorkbench.ts",
  "src/features/integration-workbench/IntegrationWorkbench.tsx",
  "src/features/integration-workbench/IntegrationWorkbench.module.css",
];

for (const relativePath of requiredFiles) {
  assert.equal(
    fs.existsSync(path.join(root, relativePath)),
    true,
    `缺少集成工作台文件：${relativePath}`,
  );
}

const typesModule = await import(
  pathToFileURL(
    path.join(root, "src/features/integration-workbench/types.ts"),
  ).href
);
const httpClientModule = await import(
  pathToFileURL(
    path.join(
      root,
      "src/features/integration-workbench/integration-http-client.ts",
    ),
  ).href
);
const typesSource = read(
  "src/features/integration-workbench/types.ts",
);
for (const internalField of [
  "repoRoot",
  "worktreePath",
  "worktreeLease",
  "sessionId",
  "apiKey",
  "promptText",
]) {
  assert.doesNotMatch(
    typesSource,
    new RegExp(`\\b${internalField}\\b`),
    `前端 DTO 不得声明内部字段：${internalField}`,
  );
}

const olderRun = {
  id: "run-old",
  sequence: 1,
  status: "succeeded",
  stage: "submit_review_and_tests",
  artifacts: [
    {
      id: "artifact-old",
      type: "initial_review",
      status: "succeeded",
      conclusion: "旧审查通过",
    },
  ],
};
const latestRun = {
  id: "run-new",
  sequence: 2,
  status: "failed",
  stage: "submit_review_and_tests",
  artifacts: [
    {
      id: "artifact-new",
      type: "initial_review",
      status: "failed",
      conclusion: null,
    },
  ],
};
const mergeRun = {
  id: "run-merge",
  sequence: 3,
  status: "succeeded",
  stage: "pre_merge_review",
  artifacts: [
    {
      id: "artifact-final",
      type: "final_review",
      status: "succeeded",
      conclusion: "合入审查通过",
    },
  ],
};
const rerunSubmit = typesModule.selectLatestStageRun(
  { runs: [olderRun, latestRun, mergeRun] },
  "submit_review_and_tests",
);
assert.equal(
  rerunSubmit?.id,
  "run-new",
  "主动重跑 CAS 必须锚定所选阶段的最新运行，而不是任务整体最新运行",
);
assert.equal(
  typesModule.selectLatestStageRun(
    { runs: [olderRun, latestRun, mergeRun] },
    "pre_merge_review",
  )?.id,
  "run-merge",
);

assert.equal(
  typesModule.selectLatestRun({ runs: [olderRun, latestRun] })?.id,
  "run-new",
  "列表必须以最高 sequence 的运行作为最新结果",
);
assert.equal(
  typesModule.selectLatestArtifact(
    { runs: [olderRun, latestRun, mergeRun] },
    "initial_review",
  )?.id,
  "artifact-new",
  "跨阶段后应保留最新提测报告，同时失败重试不能回退展示旧成功报告",
);
assert.equal(
  typesModule.selectLatestArtifactRun(
    { runs: [olderRun, latestRun, mergeRun] },
    "initial_review",
  )?.run.id,
  "run-new",
  "报告抽屉必须打开实际生成该类产物的运行",
);
assert.equal(
  typesModule.selectLatestArtifact(
    { runs: [olderRun, latestRun, mergeRun] },
    "final_review",
  )?.id,
  "artifact-final",
  "合入阶段必须展示最新合入审查",
);
assert.equal(
  typesModule.hasActiveIntegrationRuns([
    { automationStatus: "idle", canRetry: false, canDelete: true },
    { automationStatus: "running", canRetry: false, canDelete: false },
  ]),
  true,
  "存在运行中任务时必须开启轮询",
);
assert.equal(
  typesModule.hasActiveIntegrationRuns([
    { automationStatus: "idle", canRetry: false, canDelete: true },
    { automationStatus: "failed", canRetry: true, canDelete: true },
  ]),
  false,
  "无活动任务时必须停止轮询",
);
assert.equal(
  typesModule.hasActiveIntegrationRuns([
    { automationStatus: "failed", canRetry: false, canDelete: false },
  ]),
  true,
  "失败运行尚未满足安全重试条件时必须继续轮询 cleanup 状态",
);
assert.equal(
  typesModule.hasActiveIntegrationRuns([
    { automationStatus: "succeeded", canRetry: false, canDelete: false },
  ]),
  true,
  "成功运行尚未完成资源清理时也必须继续轮询删除能力",
);
assert.deepEqual(
  typesModule.getStatusActions("developing").map((item) => item.status),
  ["submitted", "closed"],
);
assert.deepEqual(
  typesModule.getStatusActions("submitted").map((item) => item.status),
  ["merge_pending", "closed"],
);

const reportRequests = typesModule.createIntegrationRevisionTracker();
const reportA = reportRequests.advance();
const reportB = reportRequests.advance();
assert.equal(
  reportRequests.isCurrent(reportA),
  false,
  "较早返回的报告请求不得覆盖较新的报告目标",
);
assert.equal(
  reportRequests.isCurrent(reportB),
  true,
  "当前报告请求应能提交响应",
);

const taskSnapshots = typesModule.createIntegrationRevisionTracker();
const listSnapshot = taskSnapshots.current();
taskSnapshots.advance();
assert.equal(
  taskSnapshots.isCurrent(listSnapshot),
  false,
  "mutation 成功后不得再应用更早取得的列表快照",
);

assert.equal(
  typesModule.resolveIntegrationFixedColumn(true, "left"),
  undefined,
  "窄屏必须取消左侧固定列，避免覆盖审查结果",
);
assert.equal(
  typesModule.resolveIntegrationFixedColumn(true, "right"),
  undefined,
  "窄屏必须取消右侧固定列",
);
assert.equal(
  typesModule.resolveIntegrationFixedColumn(false, "left"),
  "left",
  "桌面端应保留流水账固定列",
);

for (const status of [401, 403]) {
  let unauthorizedCalls = 0;
  await assert.rejects(
    httpClientModule.requestIntegrationJson("/api/integration/tasks", undefined, {
      token: "expired-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
    }),
    (error) => error instanceof httpClientModule.IntegrationUnauthorizedError,
    `HTTP ${status} 必须转为明确的鉴权失效结果`,
  );
  assert.equal(
    unauthorizedCalls,
    1,
    `HTTP ${status} 必须触发一次 token 清理与登录跳转回调`,
  );
}

assert.equal(
  await httpClientModule.requestIntegrationJson(
    "/api/integration/tasks/task-delete",
    { method: "DELETE" },
    {
      token: "valid-token",
      fetchImpl: async () => new Response(null, { status: 204 }),
      onUnauthorized: () => assert.fail("204 不得触发鉴权失效"),
    },
  ),
  null,
  "DELETE 204 空响应必须被客户端正常接受",
);

const hookSource = read(
  "src/features/integration-workbench/useIntegrationWorkbench.ts",
);
assert.match(
  hookSource,
  /expectedStatus\s*:\s*task\.status/,
  "PATCH 状态变更必须携带 expectedStatus",
);
assert.match(
  hookSource,
  /expectedRunId\s*:\s*targetRun\.id/,
  "失败重试必须携带 expectedRunId",
);
assert.match(
  hookSource,
  /rerunStage/,
  "工作台 hook 必须提供成功运行主动重跑入口",
);
assert.match(
  hookSource,
  /\/api\/integration\/tasks\/\$\{task\.id\}\/rerun/,
  "主动重跑必须调用独立 rerun 接口",
);
assert.match(
  hookSource,
  /body:\s*JSON\.stringify\(\{\s*stage,\s*expectedRunId\s*\}\)/,
  "主动重跑必须携带阶段与该阶段最新运行 CAS id",
);
assert.match(
  hookSource,
  /saveReviewNote/,
  "工作台 hook 必须提供 Review 说明保存入口",
);
assert.match(
  hookSource,
  /\/api\/integration\/tasks\/\$\{taskId\}\/artifacts\/\$\{artifactId\}\/note/,
  "Review 说明必须写入具体任务、具体产物的 note 接口",
);
assert.match(
  hookSource,
  /method:\s*"PATCH"[\s\S]*note[\s\S]*expectedUpdatedAt/,
  "Review 说明保存必须携带内容与乐观锁时间戳",
);
assert.match(
  hookSource,
  /REVIEW_NOTE_CAS_CONFLICT[\s\S]*已被其他人更新/,
  "并发修改 Review 说明时必须给出可操作的中文提示",
);
assert.match(
  hookSource,
  /\/api\/integration\/tasks\/\$\{taskId\}/,
  "报告抽屉必须读取任务详情接口",
);
assert.match(
  hookSource,
  /\/api\/integration\/tasks\/\$\{taskId\}\/conflicts/,
  "手动冲突检测必须调用独立接口",
);
assert.match(hookSource, /method:\s*"POST"/);
assert.match(
  hookSource,
  /hasActiveIntegrationRuns/,
  "轮询开关必须由活动运行状态驱动",
);
assert.match(
  hookSource,
  /if \(!enabled \|\| !hasActiveRuns\) return/,
  "非集成页或无活动运行时不得启动轮询",
);
assert.match(
  hookSource,
  /taskRevisionTracker/,
  "列表刷新与 mutation 必须共享版本门禁",
);
assert.match(
  hookSource,
  /isCurrent\(requestRevision\)/,
  "旧列表快照不得覆盖更晚的 mutation",
);
assert.match(
  hookSource,
  /method:\s*"DELETE"/,
  "删除任务必须调用 DELETE 详情接口",
);
assert.match(
  hookSource,
  /taskMutationInFlight[\s\S]*另一项任务操作正在处理，请稍候/,
  "状态、重试和删除必须共享单一 mutation 门禁",
);
assert.match(
  hookSource,
  /taskRevisionTracker\.current\.advance\(\)[\s\S]*setTasks\(\(current\)\s*=>\s*current\.filter/,
  "删除成功必须先推进列表版本，再移除本地任务",
);
assert.match(hookSource, /localStorage\.removeItem\("hm_token"\)/);
assert.match(hookSource, /window\.location\.replace\("\/login"\)/);
assert.match(
  hookSource,
  /authInvalid/,
  "鉴权失效后必须让轮询条件立即失效",
);

const workbenchSource = read(
  "src/features/integration-workbench/IntegrationWorkbench.tsx",
);
const workbenchStyles = read(
  "src/features/integration-workbench/IntegrationWorkbench.module.css",
);
assert.match(workbenchSource, /harmony-branch-code-review/);
assert.match(workbenchSource, /harmony-branch-test-cases/);
assert.match(workbenchSource, /title:\s*"冲突检测"/);
assert.match(
  workbenchSource,
  /title:\s*"合入前审查"[\s\S]*title:\s*"冲突检测"[\s\S]*key:\s*"more"/,
  "冲突检测必须位于合入前审查之后、更多操作之前",
);
assert.match(workbenchSource, /检测冲突/);
assert.match(workbenchSource, /重新检测/);
assert.match(workbenchSource, /checkMergeConflicts/);
assert.match(workbenchSource, /task\.status !== "merge_pending"/);
assert.doesNotMatch(
  workbenchSource,
  /reviewRunning/,
  "手动冲突检测不得与 Review 执行状态串联",
);
assert.match(workbenchSource, /checkingConflictTasks/);
assert.match(workbenchSource, /conflictCheckRevisions/);
assert.match(workbenchSource, /<DataTable/);
assert.match(workbenchSource, /shell\.clientHeight - ledger - head - pager - 8/);
assert.match(
  workbenchSource,
  /scroll=\{visibleTasks\.length > 0 \? \{ y: tableBodyHeight \} : undefined\}/,
  "表格滚动高度必须为表头与分页预留空间，避免页码被底部裁切",
);
assert.match(
  workbenchStyles,
  /\.tableShell\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/,
  "表格外壳必须用纵向弹性布局约束分页",
);
assert.match(
  workbenchStyles,
  /\.tableShell\s+:global\(\.ant-pagination\)\s*\{[\s\S]*?flex:\s*0 0 auto;/,
  "分页必须固定占据布局空间，不能被表体滚动区域吞掉",
);
assert.match(workbenchSource, /MarkdownMessage/);
assert.match(workbenchSource, /重新运行/);
assert.match(
  workbenchSource,
  /rerunnableStages\.includes\(/,
  "成功运行的主动重跑按钮必须消费服务端阶段门禁",
);
assert.match(
  workbenchSource,
  /selectLatestStageRun/,
  "主动重跑按钮必须选择对应阶段的最新运行作为 CAS 锚点",
);
assert.match(workbenchSource, /vm\.rerunStage\(/);
assert.match(workbenchSource, /rerunBlockedReason/);
assert.match(workbenchSource, /selectPreviousTerminalArtifactRun/);
assert.match(workbenchSource, /查看上一版/);
assert.match(workbenchSource, /运行历史/);
assert.match(workbenchSource, /destroyOnHidden/);
assert.match(workbenchSource, /放弃未保存的 Review 说明/);
assert.match(workbenchSource, /reportNoteSaving/);
assert.match(workbenchSource, /onSavingChange/);
assert.match(
  workbenchSource,
  /openReport[\s\S]*reportOpen && reportNoteSaving[\s\S]*confirmDiscardReportNote/,
  "从表格打开另一份报告时也必须保护保存中或未保存的说明",
);
assert.match(
  workbenchSource,
  /tabIndex=\{rerunDisabled \? 0 : -1\}[\s\S]*重新运行不可用/,
  "禁用重跑原因必须可由键盘聚焦并获得可访问说明",
);
assert.match(workbenchSource, /Review 说明/);
assert.match(workbenchSource, /保存说明/);
assert.match(workbenchSource, /清空说明/);
assert.match(workbenchSource, /maxLength=\{4000\}/);
assert.match(
  workbenchSource,
  /(?:artifact\.type|artifactType)\s*===\s*"initial_review"[\s\S]*(?:artifact\.type|artifactType)\s*===\s*"final_review"/,
  "说明编辑器必须仅对两类 Review 产物开放",
);
assert.match(
  workbenchSource,
  /artifact\.status\s*===\s*"succeeded"/,
  "仅成功 Review 才允许填写说明",
);
assert.match(workbenchSource, /artifact\.reviewNoteUpdatedAt/);
assert.match(workbenchSource, /artifact\.reviewNoteUpdatedBy/);
assert.match(workbenchSource, /vm\.saveReviewNote\(/);
assert.match(
  workbenchSource,
  /运行历史[\s\S]*reportDetail\?\.runs[\s\S]*selectReportTarget/,
  "报告抽屉必须能切换历史运行，重跑不能让旧报告与说明失去入口",
);
assert.match(
  workbenchSource,
  /reportNoteDirty[\s\S]*放弃未保存的 Review 说明[\s\S]*confirmDiscardReportNote/,
  "关闭抽屉或切换历史报告前必须保护未保存的 Review 说明",
);
assert.match(
  workbenchSource,
  /tabIndex=\{rerunDisabled \? 0 : -1\}[\s\S]*重新运行不可用/,
  "禁用的重跑原因必须支持键盘聚焦读取",
);
assert.match(
  workbenchSource,
  /Review 说明保存失败[\s\S]*throw cause/,
  "Review 说明保存失败必须向编辑器抛回，不能误收起保存状态",
);

assert.match(workbenchStyles, /\.conflictCheckCell/);
assert.match(
  workbenchStyles,
  /\.rerunButton[\s\S]*min-height:\s*32px/,
  "重跑操作目标不得小于 32px",
);
assert.match(workbenchStyles, /\.conflictResultClean[\s\S]*var\(--green\)/);
assert.match(workbenchStyles, /\.conflictResultConflicted[\s\S]*var\(--red\)/);
assert.match(
  workbenchStyles,
  /\.rerunButton[\s\S]*min-height:\s*32px/,
  "重跑操作高度不得小于 32px",
);
assert.match(
  workbenchSource,
  /task\.canRetry/,
  "失败重试按钮必须消费服务端返回的安全重试能力",
);
assert.match(
  workbenchSource,
  /retryBlockedReason/,
  "cleanup 未完成时必须向用户解释重试被阻塞的原因",
);
assert.match(
  workbenchSource,
  /reportRevisionTracker/,
  "报告详情请求必须使用 latest-only 版本门禁",
);
assert.match(
  workbenchSource,
  /useBreakpoint/,
  "表格列固定策略必须响应真实视口断点",
);
assert.match(workbenchSource, /DeleteOutlined/);
assert.match(
  workbenchSource,
  /key:\s*"refresh"[\s\S]*type:\s*"divider"[\s\S]*key:\s*"delete"/,
  "更多操作菜单应先刷新、分隔后展示删除",
);
assert.match(
  workbenchSource,
  /key:\s*"delete"[\s\S]*danger:\s*true[\s\S]*disabled:\s*!task\.canDelete/,
  "删除操作必须为危险态并消费服务端安全门禁",
);
assert.match(workbenchSource, /vm\.deleteTask\(task\)/);
assert.match(workbenchSource, /title:\s*"删除任务？"/);
assert.match(workbenchSource, /删除后无法恢复/);
assert.match(workbenchSource, /okButtonProps:\s*\{\s*danger:\s*true\s*\}/);
assert.match(
  workbenchSource,
  /if \(key === "refresh"\)[\s\S]*if \(key === "delete"\)/,
  "更多操作必须按菜单 key 分流，避免点击删除时误刷新",
);

const chatWorkbenchSource = read(
  "src/features/chat-workbench/ChatWorkbench.tsx",
);
assert.match(chatWorkbenchSource, /tab"\)\s*===\s*"integration"/);
assert.match(chatWorkbenchSource, /IntegrationWorkbench/);

const navSource = read("src/features/workbench-nav/WorkbenchNav.tsx");
assert.match(navSource, /integration/);
assert.match(navSource, /集成台/);

console.log("integration UI contract tests passed");
