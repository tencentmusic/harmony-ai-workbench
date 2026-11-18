import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { PackageError, packageLimits, packageRoot } from "./config";
import type { Metadata, PackageResult } from "./types";

export function artifactPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new PackageError("产物 ID 无效");
  return path.join(packageRoot(), "artifacts", id);
}
export async function runPackageProcess<T>(
  job: Record<string, unknown>,
): Promise<T> {
  const dir = path.join(packageRoot(), "jobs", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  const jobFile = path.join(dir, "input.json"),
    output = path.join(dir, "result.json");
  try {
    await fs.writeFile(
      jobFile,
      JSON.stringify({ ...job, limits: packageLimits() }),
    );
    let processError: Error | null = null;
    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [
          "--max-old-space-size=1024",
          path.join(process.cwd(), "workers/package-comparison/worker.mjs"),
          jobFile,
          output,
        ],
        {
          timeout: packageLimits().timeoutMs,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (error) => {
          processError = error;
          resolve();
        },
      );
    });
    const parsed = await fs
      .readFile(output, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (processError || parsed?.error || !parsed)
      throw new PackageError(
        parsed?.error ||
          "分析超时、内存超限或解析进程中断，请检查安装包和解析限制",
      );
    return parsed as T;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
export function inspectArtifact(id: string, format = "hap") {
  return runPackageProcess<{
    metadata: Metadata;
    size: number;
    sha256: string;
  }>({ mode: "inspect", baselinePath: artifactPath(id), format });
}

const globalWorker = globalThis as unknown as {
  packageWorker?: { timer: ReturnType<typeof setInterval>; busy: boolean };
};
async function processRun(run: { id: string; taskId: string }) {
  const timeout = packageLimits().timeoutMs;
  const claimed = await prisma.$transaction(async (tx) => {
    const running = await tx.packageAnalysis.count({
      where: { status: "running" },
    });
    if (running >= packageLimits().concurrency) return false;
    const claim = await tx.packageAnalysis.updateMany({
      where: { id: run.id, status: "queued" },
      data: {
        status: "running",
        progress: 10,
        leaseUntil: new Date(Date.now() + timeout + 60000),
      },
    });
    return claim.count > 0;
  });
  if (!claimed) return;
  try {
    const task = await prisma.packageComparison.findUniqueOrThrow({
      where: { id: run.taskId },
    });
    const [base, current] = await Promise.all([
      prisma.packageArtifact.findUniqueOrThrow({
        where: { id: task.baselineId },
      }),
      prisma.packageArtifact.findUniqueOrThrow({
        where: { id: task.currentId },
      }),
    ]);
    if (base.purgedAt || current.purgedAt)
      throw new Error("原始包已按保留策略清理，不能复算，请重新上传并创建对比");
    await prisma.packageAnalysis.update({
      where: { id: run.id },
      data: { progress: 35 },
    });
    const result = await runPackageProcess<PackageResult>({
      mode: "compare",
      format: String(
        JSON.parse(base.metadataJson).format || "HAP",
      ).toLowerCase(),
      currentFormat: String(
        JSON.parse(current.metadataJson).format || "HAP",
      ).toLowerCase(),
      baselinePath: artifactPath(base.id),
      currentPath: artifactPath(current.id),
      baselineHash: base.sha256,
      currentHash: current.sha256,
      input: JSON.parse(task.inputJson),
    });
    await prisma.packageAnalysis.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: result.completeness,
        progress: 100,
        resultJson: JSON.stringify(result),
        finishedAt: new Date(),
        leaseUntil: null,
      },
    });
  } catch (error) {
    await prisma.packageAnalysis.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "分析失败",
        finishedAt: new Date(),
        leaseUntil: null,
      },
    });
  }
}
let lastCleanup = 0;
async function cleanup() {
  if (Date.now() - lastCleanup < 3600000) return;
  lastCleanup = Date.now();
  const cutoff = new Date(
    Date.now() - packageLimits().retentionDays * 86400000,
  );
  const artifacts = await prisma.packageArtifact.findMany({
    where: { createdAt: { lt: cutoff }, purgedAt: null },
    take: 100,
  });
  for (const a of artifacts) {
    const purged = await prisma.$transaction(async (tx) => {
      const active = await tx.packageComparison.count({
        where: {
          OR: [{ baselineId: a.id }, { currentId: a.id }],
          runs: { some: { status: { in: ["queued", "running"] } } },
        },
      });
      if (active) return false;
      await tx.packageArtifact.update({
        where: { id: a.id },
        data: { purgedAt: new Date() },
      });
      return true;
    });
    if (purged) await fs.rm(artifactPath(a.id), { force: true });
  }
  // Crash leftovers: only UUID task directories/files older than the longest lease can be removed.
  for (const folder of ["jobs", "artifacts"]) {
    const root = path.join(packageRoot(), folder);
    for (const entry of await fs
      .readdir(root, { withFileTypes: true })
      .catch(() => [])) {
      if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const file = path.join(root, entry.name),
        stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs < 86400000) continue;
      if (folder === "artifacts") {
        const artifact = await prisma.packageArtifact.findUnique({
          where: { id: entry.name },
        });
        if (artifact && !artifact.purgedAt) continue;
      }
      await fs.rm(file, { force: true, recursive: true });
    }
  }
}
export async function tickPackageWorker() {
  const state = globalWorker.packageWorker;
  if (state?.busy) return;
  if (state) state.busy = true;
  try {
    await prisma.packageAnalysis.updateMany({
      where: { status: "running", leaseUntil: { lt: new Date() } },
      data: {
        status: "failed",
        error: "分析进程中断或租约超时，可重试生成新版本",
        finishedAt: new Date(),
        leaseUntil: null,
      },
    });
    // Global slots are keyed in SQLite; a short transaction prevents concurrent web processes over-claiming.
    const runs = await prisma.packageAnalysis.findMany({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      take: packageLimits().concurrency,
    });
    await Promise.all(runs.map(processRun));
    await cleanup();
  } finally {
    if (state) state.busy = false;
  }
}
export function startPackageWorker() {
  if (globalWorker.packageWorker) return;
  const timer = setInterval(() => {
    void tickPackageWorker().catch((error) =>
      console.error(
        "[package-comparison]",
        error instanceof Error ? error.message : "worker error",
      ),
    );
  }, 2000);
  timer.unref();
  globalWorker.packageWorker = { timer, busy: false };
}
