import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-api-"));
process.env.DATABASE_URL = `file:${path.join(root, "test.db")}`;
process.env.WORKSPACE_APPS_CONFIG = path.join(root, "apps.json");
process.env.PACKAGE_STORAGE_DIR = path.join(root, "storage");
process.env.PACKAGE_UPLOAD_BYTES = "1048576";
process.env.PACKAGE_ANALYSIS_CONCURRENCY = "2";
process.env.PACKAGE_ANALYSIS_TIMEOUT_MS = "10000";
delete process.env.PACKAGE_COMPARISON_CONFIG;
await fs.writeFile(
  process.env.WORKSPACE_APPS_CONFIG,
  JSON.stringify({
    schema_version: "2.0",
    projects: [{
      project_id: "package-api-test",
      sources: { android: { source_id: "test-android", path: root } },
      apps: [
        { app_id: "A", label: "业务A", scope: { android: { mode: "modules", modules: ["a"] } } },
        { app_id: "B", label: "业务B", scope: { android: { mode: "modules", modules: ["b"] } } },
      ],
    }],
  }),
);
await fs.writeFile(path.join(root, "test.db"), "");
execFileSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"],
  { env: process.env, stdio: "pipe" },
);
const { prisma } = await import("../src/lib/prisma.ts");
const { hashToken } = await import("../src/lib/token.ts");
const { packageApi } = await import("../src/lib/package-comparison/api.ts");
const { tickPackageWorker } = await import(
  "../src/lib/package-comparison/worker.ts"
);
const { defaultRules } = await import(
  "../src/lib/package-comparison/config.ts"
);
const tokenA = "test-token-a",
  tokenB = "test-token-b";
await prisma.apiToken.create({
  data: {
    id: "user-a",
    personName: "测试A",
    personCode: "A",
    tokenHash: hashToken(tokenA),
  },
});
await prisma.apiToken.create({
  data: {
    id: "user-b",
    personName: "测试B",
    personCode: "B",
    tokenHash: hashToken(tokenB),
  },
});
await prisma.apiTokenAppScope.createMany({
  data: [
    { tokenId: "user-a", appScopeId: "A" },
    { tokenId: "user-b", appScopeId: "B" },
  ],
});
async function call(route, method = "GET", body, token = tokenA, headers = {}) {
  const req = new Request(`http://localhost/api/package-comparison/${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !Buffer.isBuffer(body)
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
  });
  const res = await packageApi(req, route.split("?")[0].split("/"));
  const data = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, data };
}
async function fixture(value) {
  const zip = new JSZip();
  zip.file(
    "module.json",
    JSON.stringify({
      app: { bundleName: "test.bundle", versionName: "1", versionCode: 1 },
      module: { name: "entry" },
    }),
  );
  zip.file("code.abc", value);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
try {
  assert.equal(
    (await call("projects", "GET", undefined, "invalid")).status,
    401,
  );
  assert.deepEqual(
    (await call("projects")).data.items.map((p) => p.id),
    ["A", "B"],
  );
  assert.equal((await call("artifacts?projectId=B")).status, 200);
  assert.equal((await call("artifacts?projectId=missing")).status, 403);
  const upload = async (project, bytes, name = "sample.hap", token = tokenA) =>
    call(`artifacts?projectId=${project}`, "POST", bytes, token, {
      "x-file-name": encodeURIComponent(name),
    });
  const baselineUpload = await upload("A", await fixture("old"), "sample.hap", tokenB);
  assert.equal(baselineUpload.status, 201);
  const baseline = baselineUpload.data.item;
  const current = (await upload("A", await fixture("a larger new value"))).data
    .item;
  assert.equal(typeof baseline.size, "number");
  assert.equal((await upload("A", Buffer.from("broken"))).status, 400);
  assert.equal((await upload("A", await fixture("x"), "fake.apk")).status, 400);
  assert.equal((await upload("A", Buffer.alloc(1048577))).status, 413);
  assert.equal(
    (await fs.readdir(path.join(root, "storage/artifacts"))).length,
    2,
    "failed upload files removed",
  );
  const input = {
    title: "端到端",
    projectId: "A",
    baselineId: baseline.id,
    currentId: current.id,
    scene: "merge",
    owner: "QA",
    rules: defaultRules,
  };
  const created = await call("tasks", "POST", input);
  assert.equal(created.status, 201, JSON.stringify(created));
  let task = created.data.item;
  assert.equal(
    (await call(`tasks/${task.id}`, "GET", undefined, tokenB)).status,
    200,
  );
  assert.equal(
    (await call(`tasks/${task.id}/export?format=md`, "GET", undefined, tokenB))
      .status,
    409,
  );
  assert.equal(
    (await call("tasks", "POST", { ...input, projectId: "B" }, tokenB)).status,
    400,
  );
  await tickPackageWorker();
  task = (await call(`tasks/${task.id}`)).data.item;
  assert.equal(task.runs[0].status, "complete", task.runs[0].error);
  assert.equal(task.runs[0].progress, 100);
  const mutate = async (action, extra = {}) => {
    const r = await call(`tasks/${task.id}/${action}`, "POST", {
      revision: task.revision,
      analysisId: task.runs[0].id,
      ...extra,
    });
    if (r.status === 200) task = r.data.item;
    return r;
  };
  assert.equal(
    (await mutate("review", { status: "approved", reason: "直接通过" })).status,
    409,
  );
  assert.equal(
    (await mutate("review", { status: "pending", reason: "请审核" })).status,
    400,
  );
  assert.equal(
    (
      await mutate("explanation", {
        explanation: {
          summary: "说明用途",
          optimization: "已压缩",
          retentionReason: "需要离线使用",
        },
      })
    ).status,
    200,
  );
  const stale = { revision: task.revision, analysisId: task.runs[0].id };
  assert.equal(
    (await mutate("review", { status: "pending", reason: "请审核" })).status,
    200,
  );
  assert.equal(
    (
      await call(`tasks/${task.id}/review`, "POST", {
        ...stale,
        status: "approved",
        reason: "旧请求",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await mutate("review", {
        status: "approved",
        reason: "经人工核查用途与预算，接受增量",
      })
    ).status,
    200,
  );
  assert.equal(task.reviewStatus, "approved");
  assert.equal(task.reviews.length, 2);
  const approved = task.reviews.find((r) => r.status === "approved");
  assert.equal(approved.analysisVersion, 1);
  assert.equal(approved.explanationVersion, 2);
  assert.equal(
    (
      await mutate("explanation", {
        explanation: { summary: "补充说明的新版本" },
      })
    ).status,
    200,
  );
  assert.equal(task.reviewStatus, "draft");
  assert.equal(task.explanationVersion, 3);
  assert.equal(task.reviews.length, 2);
  const md = await call(`tasks/${task.id}/export?format=md`),
    csv = await call(`tasks/${task.id}/export?format=csv`);
  assert.equal(md.status, 200);
  assert.equal(
    (await call(`tasks/${task.id}/export?format=md`, "GET", undefined, tokenB)).status,
    200,
  );
  assert(md.data.includes("补充说明的新版本"));
  assert(csv.data.includes("code.abc"));
  assert(!md.data.includes("baselineHash"));
  assert.equal((await mutate("retry")).status, 200);
  assert.equal(task.runs[0].version, 2);
  assert.equal(task.reviewStatus, "draft");
  assert.equal((await mutate("retry")).status, 409);
  await tickPackageWorker();
  task = (await call(`tasks/${task.id}`)).data.item;
  assert.equal(task.runs[0].status, "complete");
  assert.deepEqual(task.runs[0].result, task.runs[1].result);
  // Tampering produces a persisted failure; replacing original bytes allows retry without deleting history.
  const file = path.join(root, "storage/artifacts", current.id),
    original = await fs.readFile(file);
  await fs.writeFile(file, await fixture("tamper"));
  await mutate("retry");
  await tickPackageWorker();
  task = (await call(`tasks/${task.id}`)).data.item;
  assert.equal(task.runs[0].status, "failed");
  assert.match(task.runs[0].error, /校验值/);
  await fs.writeFile(file, original);
  await mutate("retry");
  await tickPackageWorker();
  task = (await call(`tasks/${task.id}`)).data.item;
  assert.equal(task.runs[0].status, "complete");
  await prisma.packageArtifact.update({
    where: { id: current.id },
    data: { purgedAt: new Date() },
  });
  assert.equal((await mutate("retry")).status, 400);
  assert.equal((await call(`tasks/${task.id}/export?format=md`)).status, 200);
  // Restart recovery reaps an expired claim, leaving a retryable failure.
  const other = (
    await call("tasks", "POST", { ...input, currentId: baseline.id })
  ).data.item;
  await prisma.packageAnalysis.update({
    where: { id: other.runs[0].id },
    data: { status: "running", leaseUntil: new Date(0) },
  });
  await tickPackageWorker();
  assert.equal(
    (await call(`tasks/${other.id}`)).data.item.runs[0].status,
    "failed",
  );
  // A live lease consumes global capacity, even when another process owns it.
  const held = (
    await call("tasks", "POST", { ...input, currentId: baseline.id })
  ).data.item;
  const waiting = (
    await call("tasks", "POST", { ...input, currentId: baseline.id })
  ).data.item;
  process.env.PACKAGE_ANALYSIS_CONCURRENCY = "1";
  await prisma.packageAnalysis.update({
    where: { id: held.runs[0].id },
    data: { status: "running", leaseUntil: new Date(Date.now() + 60000) },
  });
  await tickPackageWorker();
  assert.equal(
    (await call(`tasks/${waiting.id}`)).data.item.runs[0].status,
    "queued",
  );
  await prisma.packageAnalysis.update({
    where: { id: held.runs[0].id },
    data: { leaseUntil: new Date(0) },
  });
  await tickPackageWorker();
  assert.equal(
    (await call(`tasks/${waiting.id}`)).data.item.runs[0].status,
    "complete",
  );
  const appFixture = async (value) => {
    const zip = new JSZip();
    zip.file(
      "pack.info",
      JSON.stringify({
        summary: {
          app: {
            bundleName: "test.bundle",
            version: { name: "1", code: 1 },
          },
        },
      }),
    );
    zip.file("entry.hap", await fixture(value));
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  };
  const appBaseUpload = await upload(
    "A",
    await appFixture("old"),
    "release.APP",
  );
  assert.equal(appBaseUpload.status, 201, JSON.stringify(appBaseUpload));
  const appBase = appBaseUpload.data.item;
  const appCurrent = (
    await upload("A", await appFixture("a larger release"), "release.app")
  ).data.item;
  assert.equal(appBase.metadata.format, "APP");
  assert.equal(
    (await upload("A", await fixture("x"), "renamed.app")).status,
    400,
  );
  assert.equal(
    (await call("tasks", "POST", { ...input, currentId: appBase.id })).status,
    400,
  );
  const appCreated = await call("tasks", "POST", {
    ...input,
    scene: "release",
    baselineId: appBase.id,
    currentId: appCurrent.id,
  });
  assert.equal(appCreated.status, 201, JSON.stringify(appCreated));
  await tickPackageWorker();
  task = (await call(`tasks/${appCreated.data.item.id}`)).data.item;
  assert.equal(task.runs[0].status, "complete", task.runs[0].error);
  const innerFile = task.runs[0].result.inner.files.find(
    (f) => f.name === "code.abc",
  );
  assert.equal(innerFile.status, "modified");
  assert.equal(
    (
      await mutate("explanation", {
        explanation: {
          summary: "APP release 审核",
          files: {
            [innerFile.key]: {
              purpose: "发布需求代码",
              necessity: "necessary",
              reason: "随版本交付",
            },
          },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await mutate("review", {
        status: "pending",
        reason: "整包和内部均已核对",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await mutate("review", {
        status: "approved",
        reason: "确认 release 变更",
      })
    ).status,
    200,
  );
  const appMd = await call(`tasks/${task.id}/export?format=md`);
  const appCsv = await call(`tasks/${task.id}/export?format=csv`);
  assert(appMd.data.includes("发布需求代码"));
  assert(appCsv.data.includes("HAP/HSP 内部 ZIP，非 APP 最终贡献"));
  assert(appCsv.data.includes("entry.hap!/code.abc"));
  assert.equal((await mutate("retry")).status, 200);
  await tickPackageWorker();
  task = (await call(`tasks/${task.id}`)).data.item;
  assert.equal(task.runs[0].status, "complete");
  assert.deepEqual(task.runs[0].result, task.runs[1].result);
  process.env.PACKAGE_ANALYSIS_TIMEOUT_MS = "1";
  const { inspectArtifact } = await import(
    "../src/lib/package-comparison/worker.ts"
  );
  await assert.rejects(inspectArtifact(baseline.id), /超时/);
  assert.equal((await fs.readdir(path.join(root, "storage/jobs"))).length, 0);
  console.log(
    "package-comparison API: upload → analysis → notes → review → export → retry passed; authorization, stale writes, retention, corrupt upload and recovery passed",
  );
} finally {
  await prisma.$disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
