export type RepoSyncFollowUpPlan = {
  codegraphProjects?: string[];
  indexingLabel?: string;
  deployCommands?: string[][];
  deployDetached?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandLabel(command: string[] | string): string {
  return Array.isArray(command) ? command.join(" ") : command;
}

function describePull(pull: unknown): string {
  if (!isRecord(pull)) return "git pull";
  if (pull.skipped) return "git pull：跳过";
  const before = typeof pull.before === "string" ? pull.before : "";
  const after = typeof pull.after === "string" ? pull.after : "";
  const preserved = Array.isArray(pull.preserved) && pull.preserved.length > 0;
  const suffix = preserved ? "，已保留本机配置" : "";
  if (before && after && before === after) return `git pull：已对齐，无新提交${suffix}`;
  if (after) return `git pull：已更新${suffix}`;
  return `git pull：已执行${suffix}`;
}

function describeCodegraph(codegraph: unknown): string {
  if (!isRecord(codegraph)) return "代码图谱：已增量更新";
  if (codegraph.skipped) {
    const reason = String(codegraph.reason || "");
    if (reason === "no_codegraph_projects" || reason === "no_projects") {
      return "代码图谱：未配置";
    }
    return `代码图谱：已跳过（${reason}）`;
  }
  return "代码图谱：已增量更新";
}

function describeIndexing(indexing: unknown): string {
  if (!isRecord(indexing)) return "类索引：已按仓更新";
  if (indexing.skipped) {
    const reason = String(indexing.reason || "");
    if (reason === "no_class_index") return "类索引：未配置";
    if (reason === "no_code_change") return "类索引：代码无更新，跳过";
    return `类索引：已跳过（${reason}）`;
  }
  const slices = typeof indexing.slices === "string" ? indexing.slices.trim() : "";
  return slices ? `类索引：已更新 ${slices}` : "类索引：已按仓更新";
}

function describeDeploy(deploy: unknown): string {
  if (!isRecord(deploy)) return "部署：已执行";
  const commands = Array.isArray(deploy.commands)
    ? deploy.commands
        .map((item) => {
          if (!isRecord(item)) return "";
          const name = String(item.command || "");
          if (!name) return "";
          return item.skipped ? `${name}（跳过）` : name;
        })
        .filter(Boolean)
    : [];
  if (deploy.detached) {
    return "部署：已交给后台部署";
  }
  if (deploy.skipped) {
    const reason = String(deploy.reason || "");
    if (reason === "no_code_change") return "部署：代码无更新，跳过";
    return `部署：已跳过（${reason}）`;
  }
  if (commands.length) return `部署：${commands.join("；")}`;
  return "部署：已执行";
}

export function describeRepoSyncFollowUps(
  result: unknown,
  planned?: RepoSyncFollowUpPlan,
): string[] {
  const rec = isRecord(result) ? result : {};
  const hasResult =
    rec.pull != null || rec.codegraph != null || rec.indexing != null || rec.deploy != null;
  if (!hasResult) {
    if (!planned) return ["仅 git pull"];
    const lines = ["git pull"];
    if (planned.indexingLabel) lines.push(`类索引：${planned.indexingLabel}`);
    if (planned.codegraphProjects?.length) {
      lines.push(`代码图谱：${planned.codegraphProjects.join("、")}`);
    }
    if (planned.deployCommands?.length) {
      const cmds = planned.deployCommands.map(commandLabel).join("；");
      lines.push(planned.deployDetached ? "部署：已交给后台部署" : `部署：${cmds}`);
    }
    return lines;
  }

  const lines: string[] = [];
  if (rec.pull != null) lines.push(describePull(rec.pull));
  if (rec.indexing != null) lines.push(describeIndexing(rec.indexing));
  if (rec.codegraph != null) lines.push(describeCodegraph(rec.codegraph));
  if (rec.deploy != null) lines.push(describeDeploy(rec.deploy));
  return lines.length ? lines : ["仅 git pull"];
}

export function plannedFollowUpsForRepoIds(
  repoIdField: string,
  repos: Array<{
    id: string;
    class_index?: boolean;
    codegraph_projects?: string[];
    deploy_on_change?: { commands: string[][]; detached?: boolean };
  }>,
): RepoSyncFollowUpPlan {
  const ids = repoIdField.split(",").map((id) => id.trim()).filter(Boolean);
  const codegraph = new Set<string>();
  let deployCommands: string[][] | undefined;
  let deployDetached = false;
  let indexingLabel = "";
  for (const id of ids) {
    const repo = repos.find((item) => item.id === id);
    if (!repo) continue;
    for (const project of repo.codegraph_projects || []) codegraph.add(project);
    if (!deployCommands && repo.deploy_on_change?.commands?.length) {
      deployCommands = repo.deploy_on_change.commands;
      deployDetached = repo.deploy_on_change.detached === true;
    }
    if (repo.class_index) indexingLabel = "有更新时按仓重建";
  }
  return {
    codegraphProjects: [...codegraph],
    indexingLabel: indexingLabel || undefined,
    deployCommands,
    deployDetached,
  };
}
