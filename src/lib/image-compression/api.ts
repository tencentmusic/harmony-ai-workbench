import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { verifyBearer } from "@/lib/token";
import type { CompressionTask } from "./types";

const MAX_UPLOAD = 50 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const root = () => path.resolve(process.env.IMAGE_COMPRESSION_DIR || ".runtime/image-compression");
const worker = () => path.join(process.cwd(), "server/image-compression/worker.py");
const python = () => process.env.IMAGE_COMPRESSION_PYTHON || "python3";
type Job = { owner: string; dir: string; createdAt: number; task: CompressionTask };
const state = globalThis as typeof globalThis & { imageCompressionJobs?: Map<string, Job>; imageCompressionUploads?: Set<string> };
const jobs = state.imageCompressionJobs ??= new Map<string, Job>();
const uploads = state.imageCompressionUploads ??= new Set<string>();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function capabilities() {
  try {
    const { stdout } = await promisify(execFile)(python(), [worker(), "--check"], { timeout: 10000 });
    return JSON.parse(stdout) as { ready: boolean; missing: string[] };
  } catch {
    return { ready: false, missing: ["Python 3 / Pillow / oxipng / cwebp / jpegtran"] };
  }
}

function start(job: Job) {
  const child = spawn(python(), [worker(), job.dir], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let pending = "";
  const timer = setTimeout(() => {
    job.task.error = "压缩超过 10 分钟，请减少图片后重试";
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
  }, 600000);
  timer.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      try {
        const progress = JSON.parse(line);
        if (typeof progress.error === "string") job.task.error = progress.error;
        if (typeof progress.completed === "number") {
          job.task.completed = progress.completed;
          job.task.total = progress.total;
        }
      } catch { /* ignore non-protocol output */ }
    }
  });
  child.on("error", () => { job.task.error = "无法启动图片压缩进程，请检查服务端依赖"; });
  child.on("close", (code) => {
    clearTimeout(timer);
    void (async () => {
      try {
        if (code !== 0 || job.task.error) throw new Error(job.task.error || "图片压缩失败，请检查文件后重试");
        job.task.report = JSON.parse(await fs.readFile(path.join(job.dir, "report.json"), "utf8"));
        job.task.status = "succeeded";
      } catch (error) {
        job.task.status = "failed";
        job.task.error = error instanceof Error ? error.message : "图片压缩失败";
        await fs.rm(job.dir, { recursive: true, force: true });
      }
    })().catch(() => { job.task.status = "failed"; });
  });
}

async function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL && job.task.status !== "running") jobs.delete(id);
  }
  // Also remove expired artifacts left by a prior service process.
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(root(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const dir = path.join(root(), entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && now - stat.mtimeMs > TTL) await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function compressionApi(req: Request, segments: string[]) {
  const token = await verifyBearer(req.headers.get("authorization"));
  if (!token) return json({ error: "请先登录" }, 401);
  const [resource, id, artifact] = segments;
  if (resource === "capabilities" && segments.length === 1 && req.method === "GET") {
    return json({ ...await capabilities(), uploadBytes: MAX_UPLOAD });
  }
  if (resource !== "tasks") return json({ error: "接口不存在" }, 404);
  if (!id && req.method === "POST") {
    const active = [...jobs.values()].filter(j => j.task.status === "running");
    if (active.length + uploads.size >= 2 || uploads.has(token.id) || active.some(j => j.owner === token.id))
      return json({ error: "当前有压缩任务处理中，请稍后重试" }, 429);
    uploads.add(token.id);
    let dir = "";
    try {
      const available = await capabilities();
      if (!available.ready) return json({ error: `服务器缺少压缩依赖：${available.missing.join("、")}` }, 503);
      let name: string;
      try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch { return json({ error: "文件名无效" }, 400); }
      if (!/\.(png|jpe?g|webp|zip)$/i.test(name) || /[/\\:\x00-\x1f]/.test(name) || name.length > 200)
        return json({ error: "请上传 PNG、JPG、JPEG、WebP 图片或混合资源 ZIP" }, 400);
      if (!req.body) return json({ error: "请选择文件" }, 400);
      if (Number(req.headers.get("content-length")) > MAX_UPLOAD) return json({ error: "上传不能超过 50 MiB" }, 413);
      await cleanup();
      const taskId = randomUUID();
      dir = path.join(root(), taskId);
      await fs.mkdir(dir, { mode: 0o700 });
      const handle = await fs.open(path.join(dir, "input"), "wx", 0o600);
      const reader = req.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_UPLOAD) { await reader.cancel(); throw new Error("上传不能超过 50 MiB"); }
          await handle.writeFile(value);
        }
      } finally { reader.releaseLock(); await handle.close(); }
      if (!bytes) throw new Error("上传文件为空");
      await fs.writeFile(path.join(dir, "name.txt"), name);
      const job: Job = { owner: token.id, dir, createdAt: Date.now(), task: { id: taskId, status: "running", completed: 0, total: 0 } };
      jobs.set(taskId, job);
      start(job);
      return json({ item: job.task }, 202);
    } catch (error) {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
      return json({ error: error instanceof Error && /上传|为空/.test(error.message) ? error.message : "上传失败，请重试" }, 400);
    } finally { uploads.delete(token.id); }
  }
  const job = jobs.get(id);
  if (!job || job.owner !== token.id || Date.now() - job.createdAt > TTL)
    return json({ error: "任务不存在或已过期，请重新上传（结果保留 24 小时，服务重启后失效）" }, 404);
  if (req.method !== "GET") return json({ error: "不支持的请求" }, 405);
  if (!artifact && segments.length === 2) return json({ item: job.task });
  if (segments.length !== 3 || !["png.zip", "webp.zip", "smallest.zip", "details.csv"].includes(artifact))
    return json({ error: "文件不存在" }, 404);
  if (job.task.status !== "succeeded") return json({ error: "压缩尚未完成" }, 409);
  try {
    const buffer = await fs.readFile(path.join(job.dir, artifact));
    return new Response(new Uint8Array(buffer), { headers: {
      "content-type": artifact.endsWith("zip") ? "application/zip" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="image-compression-${artifact}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch { return json({ error: "压缩产物已失效，请重新上传" }, 404); }
}
