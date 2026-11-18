import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import {
  readHap,
  readApp,
  comparePackages,
} from "../workers/package-comparison/analyzer.mjs";
import {
  defaultRules,
  parseRules,
  parseInput,
  packageProjects,
} from "../src/lib/package-comparison/config.ts";
import {
  csvReport,
  markdownReport,
} from "../src/lib/package-comparison/report.ts";
import { sizeText } from "../src/lib/package-comparison/types.ts";
import {
  assessPackageGrowth,
  DEFAULT_IMAGE_FILE_BYTES,
} from "../src/lib/package-comparison/assessment.ts";

assert.equal(sizeText(1024, "KB", 3), "1.000 KB");
assert.equal(sizeText(-1024, "KB", 3), "-1.000 KB");
assert.equal(sizeText(0, "KB", 3), "0.000 KB");
assert.equal(sizeText(1, "KB"), "0.001 KB");
assert.equal(sizeText(-1, "KB"), "-0.001 KB");
assert.equal(sizeText(null, "KB"), "不可用");

const limits = {
  uploadBytes: 512 * 1024 ** 2,
  fileBytes: 256 * 1024 ** 2,
  expandedBytes: 2 * 1024 ** 3,
  fileCount: 30000,
};
async function hap(
  files = {},
  manifest = {
    app: { bundleName: "example.app", versionName: "1.0", versionCode: 1 },
    module: { name: "main" },
  },
) {
  const zip = new JSZip();
  zip.file("module.json", JSON.stringify(manifest));
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const aBytes = await hap({
  "code/a.abc": "AAAA",
  "assets/a.bin": "old",
  "old.bin": "deleted",
  "one/same.txt": "one",
  "two/same.txt": "two",
  "libs/arm64-v8a/liba.so": "binary",
  "copy.txt": "duplicate",
});
const bBytes = await hap({
  "code/a.abc": "BBBB",
  "assets/a.bin": "new larger data",
  "one/same.txt": "one",
  "two/same.txt": "two",
  "libs/arm64-v8a/liba.so": "binary",
  "libs/x86_64/liba.so": "binary",
  "copy.txt": "duplicate",
  "copy2.txt": "duplicate",
  "model.onnx": "model",
  "unknown.bin": "generic",
});
const a = readHap(aBytes, limits),
  b = readHap(bBytes, limits);
const input = {
  title: "比较",
  projectId: "a",
  scene: "custom",
  owner: "QA",
  requirement: "REQ-1",
  scope: ["code/"],
  rules: {
    ...defaultRules,
    budgetBytes: 0,
    largeFileBytes: 1,
    fileGrowthBytes: 1,
    targetArchitectures: ["arm64-v8a"],
  },
  baselineMetadata: {},
  currentMetadata: {},
  compatibilityNote: "",
};
const same = comparePackages(a, a, input);
assert.equal(same.delta, 0);
assert.equal(same.positive, 0);
assert.equal(same.negative, 0);
assert(same.files.every((f) => f.status === "unchanged"));
assert(same.modules.every((m) => m.delta === 0));
assert(same.categories.every((m) => m.delta === 0));
const result = comparePackages(a, b, input);
assert.equal(
  result.files.find((f) => f.path === "code/a.abc").status,
  "modified",
);
assert.equal(
  result.files.find((f) => f.path === "code/a.abc").baselineRaw,
  result.files.find((f) => f.path === "code/a.abc").currentRaw,
);
assert.equal(result.files.find((f) => f.path === "old.bin").status, "removed");
assert.equal(
  result.files.find((f) => f.path === "model.onnx").category,
  "模型",
);
assert.equal(
  result.files.find((f) => f.path === "unknown.bin").category,
  "其他资源",
);
assert.equal(result.files.filter((f) => f.name === "same.txt").length, 2);
for (const table of [result.modules, result.categories, result.businessTypes]) {
  assert.equal(
    table.reduce((n, r) => n + r.baseline, 0) + result.overheadBaseline,
    result.baseline,
  );
  assert.equal(
    table.reduce((n, r) => n + r.current, 0) + result.overheadCurrent,
    result.current,
  );
  assert.equal(
    table.reduce((n, r) => n + r.delta, 0) + result.overheadDelta,
    result.delta,
  );
}
assert.equal(
  result.positive + result.negative + result.overheadDelta,
  result.delta,
);
assert(
  result.findings.some(
    (f) => f.kind === "duplicate" && f.message.includes("本次新增"),
  ),
);
assert(result.findings.some((f) => f.kind === "same_name"));
assert(result.findings.some((f) => f.kind === "architecture"));
assert(result.findings.some((f) => f.kind === "scope"));
assert(result.findings.some((f) => f.kind === "budget"));
assert.equal(comparePackages(b, a, input).delta, -result.delta);
assert.equal(
  comparePackages(a, b, { ...input, rules: { ...defaultRules } })
    .budgetRemaining,
  null,
);
assert.equal(comparePackages(a, b, input).budgetRemaining, -result.delta);
const changed = {
  ...input,
  projectId: "b",
  rules: {
    ...defaultRules,
    unit: "MB",
    groups: [{ prefix: "code/", name: "播放器", owner: "A" }],
    modules: [{ prefix: "assets/", name: "附属资源" }],
    categories: [
      { category: "项目自定义", prefix: "assets/", extensions: ["bin"] },
    ],
  },
};
const second = comparePackages(a, b, changed);
assert(second.businessTypes.some((r) => r.name === "播放器 × 业务代码"));
assert(second.modules.some((r) => r.name === "附属资源"));
assert.equal(
  second.files.find((f) => f.path === "assets/a.bin").category,
  "项目自定义",
);
assert.equal(
  comparePackages(a, b, input).files.find((f) => f.path === "assets/a.bin")
    .category,
  "其他资源",
);
const nested = readHap(
  await hap({ "nested.zip": await hap({ "inner.bin": "large nested file" }) }),
  limits,
);
const nestedResult = comparePackages(a, nested, input);
assert.equal(nestedResult.completeness, "partial");
assert(nestedResult.capabilities.nested.includes("不可用"));
assert(!nestedResult.files.some((f) => f.path.includes("inner.bin")));
assert(
  comparePackages(b, b, input).findings.some(
    (f) => f.kind === "duplicate" && f.message.includes("历史"),
  ),
);
assert.equal(
  comparePackages({ ...a, size: 0, overhead: 0, entries: [] }, b, input)
    .growthPercent,
  null,
);
assert.throws(() => readHap(Buffer.from("bad"), limits), /ZIP/);
assert.throws(() => readHap(aBytes, { ...limits, fileCount: 1 }), /文件数/);
assert.throws(() => readHap(aBytes, { ...limits, fileBytes: 1 }), /展开/);
assert.throws(() => readHap(aBytes, { ...limits, expandedBytes: 1 }), /展开/);
assert.throws(() => readHap(aBytes, { ...limits, uploadBytes: 1 }), /上传/);
assert.throws(() => parseRules({ ...defaultRules, budgetBytes: -1 }), /非负/);
assert.throws(() => parseRules({ ...defaultRules, budgetBytes: 0.5 }), /整数/);
assert.throws(
  () => parseRules({ ...defaultRules, categories: [{ category: "模型" }] }),
  /需指定/,
);
const damaged = Buffer.from(aBytes);
damaged[damaged.indexOf(Buffer.from("module.json")) + 11] ^= 1;
assert.throws(() => readHap(damaged, limits));
const unsafe = await hap({ "evil.txt": "unsafe" });
for (let o = 0; (o = unsafe.indexOf(Buffer.from("evil.txt"), o)) >= 0; o += 8)
  unsafe.write("../x.txt", o);
assert.throws(() => readHap(unsafe, limits), /不安全路径/);
assert.throws(
  () =>
    comparePackages(
      a,
      { ...b, metadata: { ...b.metadata, applicationId: "other.app" } },
      input,
    ),
  /应用标识/,
);
const task = {
  id: "test",
  title: "比对",
  projectId: "a",
  input,
  baselineId: "a",
  currentId: "b",
  revision: 3,
  explanationVersion: 2,
  explanation: { summary: "人工说明" },
  reviewStatus: "draft",
  runs: [{ id: "r", version: 1 }],
  reviews: [],
};
const csv = csvReport(task, result),
  md = markdownReport(task, result);
assert(csv.includes("old.bin"));
assert(csv.includes("当前解压字节"));
assert(md.includes("说明版本：2"));
assert(!md.includes(a.sha256));
assert(!csv.includes(b.sha256));
assert(md.includes("签名"));
assert(csv.includes("当前压缩占用(KB)"));
assert(md.includes("1 KB = 1,024 字节"));
assert(!csv.includes('"one/same.txt"'));
const modifiedSameSize = result.files.find((f) => f.path === "code/a.abc");
assert.equal(modifiedSameSize.status, "modified");
assert.equal(modifiedSameSize.delta, 0);
assert(csv.includes('"code/a.abc"'));
const unchanged = {
  ...result.files[0],
  path: "unchanged-only.txt",
  status: "unchanged",
};
const unchangedTask = {
  ...task,
  explanation: { files: { [unchanged.key]: { purpose: "旧说明" } } },
};
const unchangedResult = { ...result, files: [unchanged] };
assert(
  !markdownReport(unchangedTask, unchangedResult).includes(
    "unchanged-only.txt",
  ),
);
assert.equal(csvReport(unchangedTask, unchangedResult).split("\r\n").length, 1);
async function appPackage(
  packages,
  compression = "DEFLATE",
  bundleName = "example.app",
) {
  const zip = new JSZip();
  zip.file(
    "pack.info",
    JSON.stringify({
      summary: {
        app: {
          bundleName,
          version: { name: "1.0", code: 1 },
        },
      },
    }),
  );
  for (const [name, bytes] of Object.entries(packages)) zip.file(name, bytes);
  return zip.generateAsync({ type: "nodebuffer", compression });
}
function reconcile(r) {
  for (const rows of [r.modules, r.categories, r.businessTypes, r.files]) {
    assert.equal(
      rows.reduce((n, f) => n + f.baseline, 0) + r.overheadBaseline,
      r.baseline,
    );
    assert.equal(
      rows.reduce((n, f) => n + f.current, 0) + r.overheadCurrent,
      r.current,
    );
    assert.equal(
      rows.reduce((n, f) => n + f.delta, 0) + r.overheadDelta,
      r.delta,
    );
  }
  assert.equal(r.positive + r.negative + r.overheadDelta, r.delta);
}
const shared = await hap(
  { "libs/arm64-v8a/shared.so": "binary", "shared.png": "image" },
  {
    app: { bundleName: "example.app", debug: false },
    module: { name: "shared" },
  },
);
let appResult;
for (const compression of ["STORE", "DEFLATE"]) {
  const before = readApp(
    await appPackage(
      { "entry.hap": aBytes, "shared.hsp": shared },
      compression,
    ),
    limits,
  );
  const after = readApp(
    await appPackage(
      { "entry.hap": bBytes, "shared.hsp": shared },
      compression,
    ),
    limits,
  );
  const self = comparePackages(before, before, input);
  reconcile(self);
  reconcile(self.inner);
  assert.equal(self.delta, 0);
  assert.equal(self.inner.delta, 0);
  assert(self.inner.files.every((f) => f.status === "unchanged"));
  appResult = comparePackages(before, after, changed);
  reconcile(appResult);
  reconcile(appResult.inner);
  assert.equal(appResult.completeness, "complete");
  assert.equal(appResult.inner.current, bBytes.length + shared.length);
  assert.equal(
    appResult.inner.files.find((f) => f.path === "entry.hap!/code/a.abc")
      .status,
    "modified",
  );
  assert(
    appResult.inner.businessTypes.some((f) => f.name === "播放器 × 业务代码"),
  );
  assert(appResult.inner.modules.some((m) => m.name === "shared"));
  assert(appResult.modules.some((m) => m.name === "main"));
  assert(
    appResult.inner.findings.some(
      (f) =>
        f.kind === "duplicate" &&
        f.paths.includes("shared.hsp!/libs/arm64-v8a/shared.so"),
    ),
  );
  assert(!appResult.inner.findings.some((f) => f.kind.startsWith("budget")));
  assert.equal(appResult.inner.budgetRemaining, null);
  assert(!appResult.files.some((f) => f.path.endsWith(".so")));
  const container = after.entries.find((f) => f.path === "entry.hap");
  if (compression === "STORE") assert.equal(container.size, bBytes.length);
  else assert.notEqual(container.size, bBytes.length);
  const removed = comparePackages(
    before,
    readApp(await appPackage({ "entry.hap": aBytes }), limits),
    input,
  );
  assert.equal(
    removed.modules.find((m) => m.name === "shared").status,
    "removed",
  );
  assert(
    removed.inner.files
      .filter((f) => f.module === "shared")
      .every((f) => f.status === "removed"),
  );
  reconcile(removed);
  reconcile(removed.inner);
  assert.throws(() => comparePackages(a, before, input), /格式不同/);
}
const appBytes = await appPackage({
  "entry.hap": aBytes,
  "shared.hsp": shared,
});
assert.throws(() => readApp(appBytes, { ...limits, fileCount: 10 }), /文件数/);
assert.throws(
  () =>
    readApp(appBytes, {
      ...limits,
      expandedBytes: aBytes.length + shared.length + 100,
    }),
  /展开/,
);
assert.throws(() => readApp(aBytes, limits), /pack.info/);
assert.throws(() => readApp(Buffer.from("bad"), limits), /ZIP/);
const mismatchedApp = await appPackage(
  { "entry.hap": aBytes },
  "STORE",
  "other.bundle",
);
assert.throws(() => readApp(mismatchedApp, limits), /应用标识/);
const brokenInner = await appPackage({ "entry.hap": Buffer.from("broken") });
assert.throws(() => readApp(brokenInner, limits), /ZIP/);
const deeper = readApp(
  await appPackage({ "entry.hap": await hap({ "nested.hap": aBytes }) }),
  limits,
);
assert.equal(comparePackages(deeper, deeper, input).completeness, "partial");
const appCsv = csvReport(task, appResult),
  appMd = markdownReport(task, appResult);
assert(appCsv.includes("HAP/HSP 内部 ZIP，非 APP 最终贡献"));
assert(!appCsv.includes('"shared.hsp!/libs/arm64-v8a/shared.so"'));
assert(appCsv.includes('"entry.hap!/code/a.abc"'));
assert(appMd.includes("HAP/HSP 内部统计（独立口径）"));
assert(appMd.includes("entry.hap!/code/a.abc"));

const imageBaseBytes = await hap({
  "old.png": Buffer.alloc(400 * 1024, 1),
  "copy.txt": "same content",
});
const imageCurrentBytes = await hap({
  "old.png": Buffer.alloc(400 * 1024, 1),
  "new.png": Buffer.alloc(300 * 1024, 2),
  "copy.txt": "same content",
  "new-copy.txt": "same content",
});
const imageInput = { ...input, scope: [], rules: { ...defaultRules } };
const imageBase = readApp(
  await appPackage({ "entry.hap": imageBaseBytes }),
  limits,
);
const imageCurrent = readApp(
  await appPackage({ "entry.hap": imageCurrentBytes }),
  limits,
);
const imageResult = comparePackages(imageBase, imageCurrent, imageInput);
const assessment = assessPackageGrowth(imageResult);
const imageRisks = assessment.risks.filter((risk) =>
  risk.id.startsWith("image:"),
);
assert.equal(
  imageRisks.length,
  1,
  "inspect inner image once; exclude unchanged oversized image",
);
assert.equal(imageRisks[0].files[0].path, "entry.hap!/new.png");
assert(
  imageRisks[0].files[0].current < DEFAULT_IMAGE_FILE_BYTES,
  "ZIP bytes are intentionally small",
);
assert(
  imageRisks[0].evidence.includes("300.000 KB"),
  "image threshold uses original file bytes",
);
assert.equal(assessment.existingLargeImages, 1);
assert.equal(
  assessment.risks.filter((risk) => risk.id.startsWith("duplicate:")).length,
  1,
);
assert(assessment.context.some((text) => text.includes("未设置")));
assert.equal(assessment.status, "attention");
assert(
  !assessment.usesSuggestedImageLimit,
  "new rules freeze the image threshold",
);

const selfAssessment = assessPackageGrowth(
  comparePackages(imageCurrent, imageCurrent, imageInput),
);
assert.equal(DEFAULT_IMAGE_FILE_BYTES, 15 * 1024);
for (const [size, expected] of [[15360, false], [15361, true]]) {
  const boundaryResult = comparePackages(
    imageBase,
    readApp(await appPackage({ "entry.hap": await hap({
      "boundary.png": Buffer.alloc(size, 3),
    }) }), limits),
    imageInput,
  );
  const boundaryAssessment = assessPackageGrowth(boundaryResult);
  assert.equal(
    boundaryAssessment.risks.some((risk) => risk.id.startsWith("image:")),
    expected,
    `image with ${size} original bytes uses the strict 15 KB boundary`,
  );
}
assert.equal(
  selfAssessment.risks.length,
  0,
  "historical duplicates and images do not imply new growth risk",
);
assert.equal(selfAssessment.existingLargeImages, 2);
assert.equal(
  selfAssessment.status,
  "needs_context",
  "no budget is not approval",
);
const legacyRules = { ...imageResult.rules };
delete legacyRules.imageFileBytes;
assert.equal(
  assessPackageGrowth({ ...imageResult, rules: legacyRules })
    .usesSuggestedImageLimit,
  true,
);
assert.equal(
  assessPackageGrowth({
    ...imageResult,
    rules: { ...legacyRules, imageFileBytes: null },
  }).risks.some((risk) => risk.id.startsWith("image:")),
  false,
);
assert.equal(
  assessPackageGrowth({
    ...imageResult,
    rules: { ...legacyRules, imageFileBytes: 300 * 1024 },
  }).risks.some((risk) => risk.id.startsWith("image:")),
  false,
  "exactly at the image threshold is allowed",
);
assert(
  assessPackageGrowth({
    ...imageResult,
    rules: { ...imageResult.rules, budgetBytes: 0 },
  }).risks.some((risk) => risk.id === "budget"),
);
const reduced = assessPackageGrowth({
  ...imageResult,
  delta: -1,
  rules: { ...imageResult.rules, budgetBytes: 0 },
});
assert(!reduced.risks.some((risk) => risk.id === "budget"));
assert(
  reduced.risks.some((risk) => risk.id.startsWith("image:")),
  "net shrinkage does not hide individual growing images",
);
const fileNotes = Object.fromEntries(
  imageResult.inner.files.map((f) => [
    f.key,
    {
      purpose: "confirmed purpose",
      necessity: "necessary",
      contentHash: f.currentHash,
    },
  ]),
);
assert.equal(
  assessPackageGrowth(imageResult, { files: fileNotes }).unconfirmed,
  0,
);
const newImage = imageResult.inner.files.find((f) =>
  f.path.endsWith("new.png"),
);
fileNotes[newImage.key].contentHash = "stale";
assert.equal(
  assessPackageGrowth(imageResult, { files: fileNotes }).unconfirmed,
  1,
);
const cleanSelf = comparePackages(imageBase, imageBase, {
  ...imageInput,
  rules: { ...defaultRules, budgetBytes: 0 },
});
cleanSelf.baselineMetadata.mode = cleanSelf.currentMetadata.mode = "release";
assert.equal(assessPackageGrowth(cleanSelf).status, "within_rules");
assert.equal(
  assessPackageGrowth({ ...cleanSelf, completeness: "partial" }).status,
  "needs_context",
);
assert.equal(
  assessPackageGrowth({
    ...cleanSelf,
    currentMetadata: { ...cleanSelf.currentMetadata, mode: "debug" },
  }).status,
  "needs_context",
);
assert.throws(() => parseRules({ imageFileBytes: -1 }), /非负/);
assert.equal(parseRules({ imageFileBytes: null }).imageFileBytes, null);
assert.equal(parseRules({}).imageFileBytes, DEFAULT_IMAGE_FILE_BYTES);
const assessedMd = markdownReport(task, imageResult);
const assessedCsv = csvReport(task, imageResult);
assert(assessedMd.includes("## 增量合理性评估"));
assert(assessedMd.includes(imageRisks[0].evidence));
assert(assessedCsv.includes("单张图片偏大"));
assert(assessedCsv.includes("300.000 KB"));
assert(
  csvReport(task, {
    ...result,
    files: [{ ...result.files[0], path: '=HYPERLINK("evil")' }],
  }).includes("'=HYPERLINK"),
);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "package-unit-"));
try {
  const config = path.join(workspace, "apps.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      schema_version: "2.0",
      projects: [{
        project_id: "package-test",
        sources: { harmony: { source_id: "test-harmony", path: workspace } },
        apps: [
          { app_id: "A", label: "业务A", scope: { harmony: { mode: "whole-repository" } } },
          { app_id: "B", label: "业务B", scope: { harmony: { mode: "whole-repository" } } },
        ],
      }],
    }),
  );
  const rulesFile = path.join(workspace, "rules.json");
  await fs.writeFile(
    rulesFile,
    JSON.stringify({ A: input.rules, B: changed.rules }),
  );
  process.env.WORKSPACE_APPS_CONFIG = config;
  process.env.PACKAGE_COMPARISON_CONFIG = rulesFile;
  const projects = packageProjects();
  assert.equal(projects.length, 2);
  assert.equal(
    parseInput({ ...input, projectId: "B", rules: undefined }, projects).rules
      .unit,
    "MB",
  );
  assert.throws(
    () => parseInput({ ...input, projectId: "missing" }, projects),
    /权限/,
  );
  const file = path.join(workspace, "base.hap");
  await fs.writeFile(file, aBytes);
  const job = path.join(workspace, "job.json"),
    out = path.join(workspace, "out.json");
  await fs.writeFile(
    job,
    JSON.stringify({
      mode: "compare",
      baselinePath: file,
      currentPath: file,
      baselineHash: a.sha256,
      currentHash: a.sha256,
      input,
      limits,
    }),
  );
  execFileSync(process.execPath, [
    "workers/package-comparison/worker.mjs",
    job,
    out,
  ]);
  assert.equal(JSON.parse(await fs.readFile(out, "utf8")).delta, 0);
  await fs.writeFile(
    job,
    JSON.stringify({
      mode: "compare",
      baselinePath: file,
      currentPath: file,
      baselineHash: "tampered",
      currentHash: a.sha256,
      input,
      limits,
    }),
  );
  assert.throws(() =>
    execFileSync(process.execPath, [
      "workers/package-comparison/worker.mjs",
      job,
      out,
    ]),
  );
  assert(JSON.parse(await fs.readFile(out, "utf8")).error.includes("校验值"));
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
if (process.env.PACKAGE_REAL_HAP) {
  const real = readHap(await fs.readFile(process.env.PACKAGE_REAL_HAP), limits),
    self = comparePackages(real, real, input);
  assert.equal(self.delta, 0);
  assert(self.files.every((f) => f.status === "unchanged"));
  assert.equal(
    self.files.reduce((n, f) => n + f.current, 0) + self.overheadCurrent,
    real.size,
  );
  console.log(
    `真实 HAP：${real.size} 字节，${real.entries.length} 文件，自比对及字节对账通过`,
  );
}
if (process.env.PACKAGE_REAL_APP) {
  const real = readApp(await fs.readFile(process.env.PACKAGE_REAL_APP), limits);
  const self = comparePackages(real, real, {
    ...input,
    scope: [],
    rules: defaultRules,
  });
  reconcile(self);
  reconcile(self.inner);
  assert.equal(self.delta, 0);
  assert.equal(self.inner.delta, 0);
  assert(self.inner.files.every((f) => f.status === "unchanged"));
  console.log(
    `真实 APP：${real.size} 字节，${real.entries.length} 个外层文件，${real.inner.entries.length} 个内部文件；自身对比及两层字节对账通过`,
  );
  if (process.env.PACKAGE_REAL_APP_CURRENT) {
    const next = readApp(
      await fs.readFile(process.env.PACKAGE_REAL_APP_CURRENT),
      limits,
    );
    const compared = comparePackages(real, next, {
      ...input,
      scope: [],
      rules: defaultRules,
    });
    reconcile(compared);
    reconcile(compared.inner);
    console.log(
      `真实 APP 跨版本：${compared.baseline} → ${compared.current} 字节，净增 ${compared.delta} 字节；${compared.modules.length} 个模块分组，${compared.inner.files.length} 个内部文件，两层字节对账通过`,
    );
  }
}
console.log(
  "package-comparison: parser, diff, reconciliation, rules, export, scope and worker checks passed",
);
