import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { verifyBearer } from "@/lib/token";
import { readIntegrationJsonBody } from "@/server/modules/integration/public";
import {
  check,
  object,
  packageLimits,
  packageProjects,
  PackageError,
  parseInput,
  string,
} from "./config";
import { artifactPath, inspectArtifact, startPackageWorker } from "./worker";
import { csvReport, markdownReport } from "./report";
import type {
  Artifact,
  Comparison,
  Explanation,
  FileExplanation,
  PackageResult,
} from "./types";

const includeDetail = {
  runs: { orderBy: { version: "desc" as const } },
  reviews: { orderBy: { createdAt: "desc" as const } },
};
type TaskRow = NonNullable<Awaited<ReturnType<typeof taskRow>>>;
const taskRow = (id: string) =>
  prisma.packageComparison.findUnique({
    where: { id },
    include: includeDetail,
  });
const artifactDto = (a: {
  id: string;
  projectId: string;
  name: string;
  size: number | bigint;
  metadataJson: string;
  createdAt: Date;
  purgedAt: Date | null;
}): Artifact => ({
  id: a.id,
  projectId: a.projectId,
  name: a.name,
  size: Number(a.size),
  metadata: JSON.parse(a.metadataJson),
  createdAt: a.createdAt.toISOString(),
  purgedAt: a.purgedAt?.toISOString() || null,
});
type DtoRow = Omit<TaskRow, "runs"> & {
  runs: Array<
    Omit<TaskRow["runs"][number], "resultJson"> & { resultJson?: string | null }
  >;
};
function dto(row: DtoRow, detail = true): Comparison {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    baselineId: row.baselineId,
    currentId: row.currentId,
    input: JSON.parse(row.inputJson),
    revision: row.revision,
    explanationVersion: row.explanationVersion,
    explanation: detail ? JSON.parse(row.explanationJson) : {},
    reviewStatus: row.reviewStatus as Comparison["reviewStatus"],
    createdAt: row.createdAt.toISOString(),
    runs: row.runs.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      progress: r.progress,
      error: r.error,
      result: detail && r.resultJson ? JSON.parse(r.resultJson) : null,
      createdAt: r.createdAt.toISOString(),
    })),
    reviews: detail
      ? row.reviews.map((r) => ({
          id: r.id,
          analysisVersion: r.analysisVersion,
          explanationVersion: r.explanationVersion,
          status: r.status as Comparison["reviewStatus"],
          reason: r.reason,
          actorName: r.actorName,
          createdAt: r.createdAt.toISOString(),
          explanation: JSON.parse(r.explanationJson),
        }))
      : undefined,
  };
}
async function detail(row: TaskRow) {
  const data = dto(row);
  const artifacts = await prisma.packageArtifact.findMany({
    where: { id: { in: [row.baselineId, row.currentId] } },
  });
  data.baseline = artifacts.find((a) => a.id === row.baselineId)
    ? artifactDto(artifacts.find((a) => a.id === row.baselineId)!)
    : undefined;
  data.current = artifacts.find((a) => a.id === row.currentId)
    ? artifactDto(artifacts.find((a) => a.id === row.currentId)!)
    : undefined;
  return data;
}
function explanation(
  value: unknown,
  result: PackageResult,
  previous: Explanation,
): Explanation {
  const v = object(value),
    notes = v.files === undefined ? previous.files || {} : object(v.files);
  const allFiles = [...result.files, ...(result.inner?.files || [])];
  check(Object.keys(notes).length <= allFiles.length, "文件说明超出清单");
  const files: Record<string, FileExplanation> = {};
  const map = new Map(allFiles.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(notes)) {
    const file = map.get(key);
    check(file, "文件已不在当前结果中");
    const n = object(raw);
    check(
      ["necessary", "optimizable", "unconfirmed"].includes(
        n.necessity as string,
      ),
      "必要性选项无效",
    );
    files[key] = {
      purpose: string(n.purpose, "文件用途"),
      necessity: n.necessity as FileExplanation["necessity"],
      optimization: string(n.optimization, "已做优化"),
      reason: string(n.reason, "保留原因"),
      contentHash: file.currentHash || file.baselineHash,
    };
  }
  return {
    summary: string(v.summary, "增量来源与用途"),
    optimization: string(v.optimization, "已做优化"),
    retentionReason: string(v.retentionReason, "保留原因"),
    files,
  };
}
let inspections = 0;
export async function packageApi(req: Request, segments: string[]) {
  try {
    const token = await verifyBearer(req.headers.get("authorization"));
    check(token, "登录已失效", 401);
    const projects = packageProjects(),
      allowed = projects.map((p) => p.id);
    const project = (id: unknown) => {
      check(
        typeof id === "string" && allowed.includes(id),
        "项目不存在或无访问权限",
        403,
      );
      return id;
    };
    const [resource, id, action] = segments;
    check(segments.length <= 3, "接口不存在", 404);
    if (resource === "projects" && req.method === "GET")
      return Response.json({ items: projects, limits: packageLimits() });
    if (resource === "artifacts" && !id) {
      const projectId = project(new URL(req.url).searchParams.get("projectId"));
      if (req.method === "GET") {
        const items = await prisma.packageArtifact.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        return Response.json({ items: items.map(artifactDto) });
      }
      if (req.method === "POST") {
        check(
          inspections < packageLimits().concurrency,
          "当前上传分析繁忙，请稍后重试",
          429,
        );
        let filename: string;
        try {
          filename = decodeURIComponent(req.headers.get("x-file-name") || "");
        } catch {
          throw new PackageError("文件名编码错误");
        }
        filename = string(filename, "文件名", true, 240);
        check(
          /\.(app|hap)$/i.test(filename) && !/[\\/]/.test(filename),
          "支持 HarmonyOS .app 或 .hap 文件",
        );
        check(req.body, "请选择安装包");
        const max = packageLimits().uploadBytes,
          declared = req.headers.get("content-length");
        if (declared)
          check(
            /^\d+$/.test(declared) && Number(declared) <= max,
            "安装包超过上传限制",
            413,
          );
        const artifactId = randomUUID(),
          destination = artifactPath(artifactId);
        inspections++;
        try {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          const handle = await fs.open(destination, "wx", 0o600),
            reader = req.body.getReader();
          let total = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.length;
              if (total > max) {
                await reader.cancel();
                throw new PackageError("安装包超过上传限制", 413);
              }
              await handle.writeFile(value);
            }
          } finally {
            reader.releaseLock();
            await handle.close();
          }
          check(total > 0, "安装包为空");
          const inspected = await inspectArtifact(
            artifactId,
            path.extname(filename).slice(1).toLowerCase(),
          );
          const row = await prisma.packageArtifact.create({
            data: {
              id: artifactId,
              projectId,
              name: filename,
              size: BigInt(inspected.size),
              sha256: inspected.sha256,
              metadataJson: JSON.stringify(inspected.metadata),
              createdBy: token.id,
            },
          });
          return Response.json({ item: artifactDto(row) }, { status: 201 });
        } catch (error) {
          await fs.rm(destination, { force: true });
          throw error;
        } finally {
          inspections--;
        }
      }
    }
    if (resource === "tasks" && !id && req.method === "GET") {
      const rows = await prisma.packageComparison.findMany({
        where: { projectId: { in: allowed } },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: {
          runs: {
            orderBy: { version: "desc" },
            take: 1,
            omit: { resultJson: true },
          },
          reviews: { take: 0 },
        },
      });
      return Response.json({ items: rows.map((r) => dto(r, false)) });
    }
    if (resource === "tasks" && !id && req.method === "POST") {
      const body = object(
          await readIntegrationJsonBody(req, { maxBytes: 128 * 1024 }),
        ),
        input = parseInput(body, projects);
      const baselineId = string(body.baselineId, "基准产物", true, 36),
        currentId = string(body.currentId, "当前产物", true, 36);
      const task = await prisma.$transaction(async (tx) => {
        const artifacts = await tx.packageArtifact.findMany({
          where: {
            id: { in: [baselineId, currentId] },
            projectId: input.projectId,
            purgedAt: null,
          },
        });
        check(
          [baselineId, currentId].every((id) =>
            artifacts.some((a) => a.id === id),
          ),
          "产物不存在、已清理或不属于当前项目",
        );
        const bm = JSON.parse(
            artifacts.find((a) => a.id === baselineId)!.metadataJson,
          ),
          cm = JSON.parse(
            artifacts.find((a) => a.id === currentId)!.metadataJson,
          );
        check(bm.applicationId === cm.applicationId, "两份产物应用标识不同");
        check(
          bm.format === cm.format,
          "两份产物格式不同，请使用两份 APP 或两份 HAP",
        );
        return tx.packageComparison.create({
          data: {
            id: randomUUID(),
            projectId: input.projectId,
            title: input.title,
            inputJson: JSON.stringify(input),
            baselineId,
            currentId,
            createdBy: token.id,
            runs: { create: { id: randomUUID(), version: 1 } },
          },
          include: includeDetail,
        });
      });
      startPackageWorker();
      return Response.json({ item: await detail(task) }, { status: 201 });
    }
    if (resource === "tasks" && id) {
      const task = await taskRow(id);
      check(
        task && allowed.includes(task.projectId),
        "对比任务不存在或无访问权限",
        404,
      );
      if (req.method === "GET" && !action)
        return Response.json({ item: await detail(task) });
      if (req.method === "GET" && action === "export") {
        const format = new URL(req.url).searchParams.get("format");
        check(format === "md" || format === "csv", "导出格式无效");
        const data = await detail(task),
          result = data.runs[0]?.result;
        check(result, "当前分析版本尚无结果", 409);
        return new Response(
          format === "md"
            ? markdownReport(data, result)
            : csvReport(data, result),
          {
            headers: {
              "content-type":
                format === "md"
                  ? "text/markdown; charset=utf-8"
                  : "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="package-comparison-${id}.${format}"`,
              "cache-control": "no-store",
            },
          },
        );
      }
      if (
        req.method === "POST" &&
        ["retry", "explanation", "review"].includes(action)
      ) {
        const body = object(
            await readIntegrationJsonBody(req, { maxBytes: 2 * 1024 * 1024 }),
          ),
          run = task.runs[0];
        check(
          body.revision === task.revision && body.analysisId === run?.id,
          "记录已更新，请刷新后重试",
          409,
        );
        await prisma.$transaction(async (tx) => {
          // CAS locks the task and protects analysis/notes/review against concurrent changes.
          const updated = await tx.packageComparison.updateMany({
            where: { id: task.id, revision: task.revision },
            data: { revision: { increment: 1 } },
          });
          check(updated.count, "记录已更新，请刷新后重试", 409);
          if (action === "retry") {
            check(
              !["queued", "running"].includes(run.status),
              "已有分析正在执行",
              409,
            );
            const retained = await tx.packageArtifact.count({
              where: {
                id: { in: [task.baselineId, task.currentId] },
                purgedAt: null,
              },
            });
            check(
              retained === (task.baselineId === task.currentId ? 1 : 2),
              "原始包已清理，复算受限",
            );
            await tx.packageAnalysis.create({
              data: {
                id: randomUUID(),
                taskId: task.id,
                version: run.version + 1,
              },
            });
            await tx.packageComparison.update({
              where: { id: task.id },
              data: { reviewStatus: "draft" },
            });
          } else {
            check(
              run.resultJson && ["complete", "partial"].includes(run.status),
              "分析完成后才能填写说明或审核",
              409,
            );
            if (action === "explanation") {
              const next = explanation(
                body.explanation,
                JSON.parse(run.resultJson),
                JSON.parse(task.explanationJson),
              );
              await tx.packageComparison.update({
                where: { id: task.id },
                data: {
                  explanationJson: JSON.stringify(next),
                  explanationVersion: { increment: 1 },
                  reviewStatus: "draft",
                },
              });
            } else {
              const status = string(body.status, "审核状态", true),
                reason = string(body.reason, "审核原因", true);
              check(
                ["pending", "needs_info", "approved", "rejected"].includes(
                  status,
                ),
                "审核状态无效",
              );
              check(
                status === "pending"
                  ? ["draft", "needs_info", "rejected"].includes(
                      task.reviewStatus,
                    )
                  : task.reviewStatus === "pending",
                "请先提交审核，或刷新当前审核状态",
                409,
              );
              const note = JSON.parse(task.explanationJson) as Explanation;
              check(note.summary?.trim(), "请先填写增量来源与用途");
              await tx.packageReview.create({
                data: {
                  id: randomUUID(),
                  taskId: task.id,
                  analysisId: run.id,
                  analysisVersion: run.version,
                  explanationVersion: task.explanationVersion,
                  baselineId: task.baselineId,
                  currentId: task.currentId,
                  explanationJson: task.explanationJson,
                  status,
                  reason,
                  actorId: token.id,
                  actorName: token.personName,
                },
              });
              // Keep the optimistic-lock revision monotonic; explanation version changes only when notes are saved.
              await tx.packageComparison.update({
                where: { id: task.id },
                data: { reviewStatus: status },
              });
            }
          }
        });
        if (action === "retry") startPackageWorker();
        return Response.json({ item: await detail((await taskRow(id))!) });
      }
    }
    throw new PackageError("接口不存在", 404);
  } catch (error) {
    if (!(error instanceof PackageError))
      console.error(
        "[package-comparison API]",
        error instanceof Error ? error.message : "unknown error",
      );
    const status =
      error instanceof PackageError
        ? error.status
        : (error as { httpStatus?: number })?.httpStatus || 500;
    return Response.json(
      {
        error:
          error instanceof PackageError
            ? error.message
            : status < 500
              ? "请求格式错误或超出大小限制"
              : "包体对比服务暂不可用，请检查服务日志",
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
