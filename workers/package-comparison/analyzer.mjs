import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const ALGORITHM = "hap-zip-entry-v1";
export const APP_ALGORITHM = "app-zip-boundaries-v1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (text) => {
  throw new Error(text);
};
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = -1;
  for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ -1) >>> 0;
}

// Read central-directory lengths before inflation. Never extract paths or execute package content.
function readZip(bytes, limits, state = { count: 0, expanded: 0 }, onFile) {
  if (bytes.length > limits.uploadBytes) fail("安装包超过上传限制");
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (
      b.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + b.readUInt16LE(i + 20) === b.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("不是有效的 ZIP 安装包，缺少归档目录");
  const count = b.readUInt16LE(end + 10),
    cdSize = b.readUInt32LE(end + 12),
    cd = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    count === 65535 ||
    cd === 0xffffffff ||
    b.readUInt16LE(end + 8) !== count
  )
    fail("暂不支持多卷或 ZIP64 归档");
  state.count += count;
  if (state.count > limits.fileCount || cd + cdSize !== end)
    fail("文件数超限或归档目录损坏");
  let offset = cd,
    compressedTotal = 0;
  const entries = [],
    names = new Set(),
    ranges = [],
    methods = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || b.readUInt32LE(offset) !== 0x02014b50)
      fail("归档目录损坏");
    const flags = b.readUInt16LE(offset + 8),
      method = b.readUInt16LE(offset + 10),
      crc = b.readUInt32LE(offset + 16);
    const compressed = b.readUInt32LE(offset + 20),
      raw = b.readUInt32LE(offset + 24);
    const nl = b.readUInt16LE(offset + 28),
      xl = b.readUInt16LE(offset + 30),
      cl = b.readUInt16LE(offset + 32),
      local = b.readUInt32LE(offset + 42);
    const next = offset + 46 + nl + xl + cl;
    if (next > end || local + 30 > cd) fail("归档条目越界");
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(offset + 46, offset + 46 + nl),
    );
    if (
      !path ||
      path.length > 2048 ||
      /[\\\x00-\x1f\x7f]/.test(path) ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.split("/").some((p) => p === ".." || p === ".")
    )
      fail("归档包含不安全路径");
    if (names.has(path)) fail("归档包含重复路径");
    names.add(path);
    if (flags & 1 || ![0, 8].includes(method)) fail("不支持加密或该压缩算法");
    if (((b.readUInt32LE(offset + 38) >>> 16) & 0xf000) === 0xa000)
      fail("不支持符号链接条目");
    state.expanded += raw;
    const maxFileBytes =
      onFile && /\.(hap|hsp)$/i.test(path)
        ? limits.uploadBytes
        : limits.fileBytes;
    if (raw > maxFileBytes || state.expanded > limits.expandedBytes)
      fail("展开体积超限");
    if (["module.json", "pack.info"].includes(path) && raw > 2 * 1024 * 1024)
      fail(`${path} 超过 2 MiB 限制`);
    if (
      b.readUInt32LE(local) !== 0x04034b50 ||
      b.readUInt16LE(local + 8) !== method ||
      b.readUInt16LE(local + 6) !== flags
    )
      fail("本地条目头不一致");
    const localName = b.readUInt16LE(local + 26),
      start = local + 30 + localName + b.readUInt16LE(local + 28);
    if (
      start + compressed > cd ||
      !b
        .subarray(local + 30, local + 30 + localName)
        .equals(b.subarray(offset + 46, offset + 46 + nl))
    )
      fail("条目长度或路径不一致");
    ranges.push([local, start + compressed]);
    const packed = b.subarray(start, start + compressed);
    const data =
      method === 0
        ? packed
        : inflateRawSync(packed, {
            maxOutputLength: Math.max(1, Math.min(raw, maxFileBytes)),
          });
    if (data.length !== raw || crc32(data) !== crc)
      fail("文件长度或 CRC 校验失败");
    methods.add(method === 0 ? "STORE" : "DEFLATE");
    if (!path.endsWith("/")) {
      const entry = {
        path,
        size: compressed,
        raw,
        hash: sha(data),
        data: ["module.json", "pack.info"].includes(path) ? data : null,
      };
      onFile?.(entry, data, state);
      entries.push(entry);
    } else if (raw) fail("目录条目含有数据");
    if (!path.endsWith("/")) compressedTotal += compressed;
    offset = next;
  }
  if (offset !== end) fail("目录长度不一致");
  ranges.sort((a, z) => a[0] - z[0]);
  if (ranges.some((r, i) => i && r[0] < ranges[i - 1][1]))
    fail("归档条目范围重叠");
  return {
    size: b.length,
    sha256: sha(b),
    overhead: b.length - compressedTotal,
    entries,
    compression: `ZIP ${[...methods].sort().join("/")}`,
  };
}
export function readHap(bytes, limits, state) {
  const archive = readZip(bytes, limits, state);
  const { entries } = archive;
  const manifest = entries.find((e) => e.path === "module.json");
  if (!manifest || manifest.raw > 2 * 1024 * 1024)
    fail("HAP 必须包含有效 module.json（不超过 2 MiB）");
  let json;
  try {
    json = JSON.parse(manifest.data.toString("utf8"));
  } catch {
    fail("module.json 无法读取");
  }
  if (
    typeof json?.app?.bundleName !== "string" ||
    typeof json?.module?.name !== "string" ||
    !json.app.bundleName ||
    !json.module.name ||
    json.app.bundleName.length > 512 ||
    json.module.name.length > 256
  )
    fail("module.json 缺少有效的应用标识或模块标识");
  const metadata = {
    platform: "HarmonyOS",
    format: "HAP",
    applicationId: String(json.app.bundleName),
    version: String(json.app.versionName ?? ""),
    build: String(json.app.versionCode ?? ""),
    module: String(json.module.name),
    mode:
      typeof json.app.debug === "boolean"
        ? json.app.debug
          ? "debug"
          : "release"
        : "",
    architectures: [
      ...new Set(entries.map((e) => architecture(e.path)).filter(Boolean)),
    ]
      .sort()
      .join(","),
    compression: "",
    archiveCompression: archive.compression,
  };
  return {
    size: archive.size,
    sha256: archive.sha256,
    metadata,
    overhead: archive.overhead,
    entries: entries.map(({ data, ...e }) => e),
  };
}

export function readApp(bytes, limits) {
  const modules = [];
  const archive = readZip(bytes, limits, undefined, (entry, data, state) => {
    if (!/\.(hap|hsp)$/i.test(entry.path)) return;
    const parsed = readHap(data, limits, state);
    entry.module = parsed.metadata.module;
    entry.category = entry.path.toLowerCase().endsWith(".hap")
      ? "HAP 模块包"
      : "HSP 共享包";
    entry.expanded = true;
    modules.push({ ...parsed, container: entry.path });
  });
  const manifest = archive.entries.find((e) => e.path === "pack.info");
  if (!manifest || !modules.length)
    fail("APP 必须包含 pack.info 和至少一个 HAP/HSP 模块包");
  let app;
  try {
    app = JSON.parse(manifest.data.toString("utf8"))?.summary?.app;
  } catch {
    fail("pack.info 无法读取");
  }
  if (
    typeof app?.bundleName !== "string" ||
    !app.bundleName ||
    app.bundleName.length > 512
  )
    fail("pack.info 缺少有效应用标识");
  if (modules.some((m) => m.metadata.applicationId !== app.bundleName))
    fail("APP 与内部模块的应用标识不一致");
  const values = (field) =>
    [...new Set(modules.map((m) => m.metadata[field]).filter(Boolean))].sort();
  const modes = values("mode");
  const metadata = {
    platform: "HarmonyOS",
    format: "APP",
    applicationId: app.bundleName,
    version: String(app.version?.name ?? ""),
    build: String(app.version?.code ?? ""),
    module: values("module").join(","),
    mode: modules.every((m) => m.metadata.mode) ? modes.join(",") : "",
    architectures: [
      ...new Set(
        modules
          .flatMap((m) => m.metadata.architectures.split(","))
          .filter(Boolean),
      ),
    ]
      .sort()
      .join(","),
    archiveCompression: archive.compression,
    moduleCompression: values("archiveCompression").join(","),
  };
  return {
    size: archive.size,
    sha256: archive.sha256,
    overhead: archive.overhead,
    metadata,
    entries: archive.entries.map(({ data, ...e }) => ({
      ...e,
      module: e.module || "APP 清单与其他文件",
    })),
    inner: {
      view: "inner",
      size: modules.reduce((n, m) => n + m.size, 0),
      overhead: modules.reduce((n, m) => n + m.overhead, 0),
      metadata,
      entries: modules.flatMap((m) =>
        m.entries.map((e) => ({
          ...e,
          module: m.metadata.module,
          relativePath: e.path,
          path: `${m.container}!/${e.path}`,
        })),
      ),
    },
  };
}
function architecture(path) {
  return (
    path.match(
      /(?:^|\/)(arm64-v8a|armeabi-v7a|armeabi|x86_64|x86|arm64|riscv64)(?:\/|$)/,
    )?.[1] || ""
  );
}
function classify(path, rules) {
  const lower = path.toLowerCase(),
    ext = lower.split(".").pop();
  for (const r of rules.categories)
    if (
      (!r.prefix || path.startsWith(r.prefix)) &&
      (!r.extensions?.length ||
        r.extensions
          .map((x) => x.replace(/^\./, "").toLowerCase())
          .includes(ext))
    )
      return r.category;
  for (const [name, exts] of Object.entries({
    业务代码: ["abc", "dex", "js", "wasm"],
    原生库: ["so", "dylib"],
    图片: ["png", "jpg", "jpeg", "webp", "svg", "gif", "heic", "avif"],
    "音频/视频": ["mp3", "mp4", "wav", "ogg", "aac", "flac"],
    模型: ["tflite", "onnx", "pt", "mlmodel"],
    字体: ["ttf", "otf", "woff", "woff2"],
    配置: ["json", "xml", "yaml", "yml", "ini"],
  }))
    if (exts.includes(ext)) return name;
  return "其他资源";
}
function decorate(entry, artifact, rules) {
  const matches = (r) =>
    entry.path.startsWith(r.prefix) || entry.relativePath?.startsWith(r.prefix);
  const group = rules.groups.find(matches);
  const module =
    rules.modules.find(matches)?.name ||
    entry.module ||
    artifact.metadata.module ||
    "未分组";
  return {
    ...entry,
    module,
    key: `${artifact.view === "inner" ? "inner:" : ""}${module}:${entry.path}`,
    name: entry.path.split("/").pop(),
    category:
      entry.category || classify(entry.relativePath || entry.path, rules),
    group: group?.name || "未分组",
    owner: group?.owner || "",
    architecture: architecture(entry.path),
  };
}
function aggregate(files, key) {
  const map = new Map();
  for (const f of files) {
    const name = key(f);
    const r = map.get(name) || {
      name,
      baseline: 0,
      current: 0,
      delta: 0,
      status: "unchanged",
    };
    r.baseline += f.baseline;
    r.current += f.current;
    r.delta += f.delta;
    if (f.status !== "unchanged") r.status = "modified";
    map.set(name, r);
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      status:
        !r.baseline && r.current
          ? "added"
          : r.baseline && !r.current
            ? "removed"
            : r.status,
    }))
    .sort(
      (a, b) =>
        b.delta - a.delta || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}
export function comparePackages(base, current, input) {
  if (base.metadata.format !== current.metadata.format)
    fail("两份产物格式不同，请使用两份 APP 或两份 HAP");
  const isApp = base.metadata.format === "APP";
  const isInner = base.view === "inner";
  const rules = input.rules;
  const a = new Map(
    base.entries.map((e) => {
      const f = decorate(e, base, rules);
      return [f.key, f];
    }),
  );
  const b = new Map(
    current.entries.map((e) => {
      const f = decorate(e, current, rules);
      return [f.key, f];
    }),
  );
  const files = [...new Set([...a.keys(), ...b.keys()])]
    .map((key) => {
      const old = a.get(key),
        next = b.get(key),
        e = next || old;
      return {
        key,
        module: e.module,
        path: e.path,
        name: e.name,
        category: e.category,
        group: e.group,
        owner: e.owner,
        architecture: e.architecture,
        status: !old
          ? "added"
          : !next
            ? "removed"
            : old.hash !== next.hash || old.size !== next.size
              ? "modified"
              : "unchanged",
        baseline: old?.size ?? 0,
        current: next?.size ?? 0,
        delta: (next?.size ?? 0) - (old?.size ?? 0),
        baselineRaw: old?.raw ?? 0,
        currentRaw: next?.raw ?? 0,
        baselineHash: old?.hash ?? null,
        currentHash: next?.hash ?? null,
        expanded: !!(old?.expanded || next?.expanded),
      };
    })
    .sort(
      (a, b) =>
        b.delta - a.delta || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const findings = [],
    add = (kind, message, paths = []) =>
      findings.push({ kind, message, paths });
  const hashes = new Map(),
    names = new Map(),
    baselineHashCounts = new Map();
  for (const e of a.values())
    baselineHashCounts.set(e.hash, (baselineHashCounts.get(e.hash) || 0) + 1);
  for (const e of b.values()) {
    if (e.raw > 0) {
      const list = hashes.get(e.hash) || [];
      list.push(e);
      hashes.set(e.hash, list);
    }
    const list = names.get(e.name) || [];
    list.push(e);
    names.set(e.name, list);
  }
  for (const [hash, list] of hashes)
    if (list.length > 1) {
      const prior = baselineHashCounts.get(hash) || 0;
      const added = list.some((e) => a.get(e.key)?.hash !== hash);
      add(
        "duplicate",
        `${added || prior < list.length ? "本次新增重复" : "历史重复"}：${list.length} 份相同内容；需确认加载与依赖，不能直接视为可节省大小`,
        list.map((e) => e.path),
      );
    }
  for (const list of names.values())
    if (new Set(list.map((e) => e.hash)).size > 1)
      add(
        "same_name",
        "同名不同内容，不属于相同内容副本",
        list.map((e) => e.path),
      );
  for (const f of files) {
    if (
      (rules.largeFileBytes !== null && f.current >= rules.largeFileBytes) ||
      (rules.fileGrowthBytes !== null &&
        f.delta > 0 &&
        f.delta >= rules.fileGrowthBytes)
    )
      add(
        "large_file",
        "达到文件体积或增长阈值，请确认用途、必要性及保留原因（ZIP 压缩占用）",
        [f.path],
      );
    if (
      f.currentHash &&
      f.architecture &&
      rules.targetArchitectures.length &&
      !rules.targetArchitectures.includes(f.architecture)
    )
      add(
        "architecture",
        `非目标架构：${f.architecture}，压缩占用 ${f.current} 字节`,
        [f.path],
      );
    if (
      input.scope.length &&
      f.status !== "unchanged" &&
      !input.scope.some((p) => f.path.startsWith(p) || f.module === p)
    )
      add("scope", "需求声明范围之外的变化，请核查", [f.path]);
    if (
      f.currentHash &&
      ["图片", "音频/视频", "模型"].includes(f.category) &&
      rules.largeFileBytes !== null &&
      f.current >= rules.largeFileBytes
    )
      add("resource", "大资源内置：可评估按需交付或精简，需运行验证", [f.path]);
  }
  const arch = [
    ...new Set([...b.values()].map((e) => e.architecture).filter(Boolean)),
  ];
  if (arch.length > 1)
    add(
      "architecture",
      `存在多架构原生库：${arch.join("、")}，按架构筛选查看完整占用`,
    );
  const bm = {
    ...input.baselineMetadata,
    ...Object.fromEntries(Object.entries(base.metadata).filter(([, v]) => v)),
  };
  const cm = {
    ...input.currentMetadata,
    ...Object.fromEntries(
      Object.entries(current.metadata).filter(([, v]) => v),
    ),
  };
  for (const key of [
    "applicationId",
    "module",
    "channel",
    "variant",
    "architectures",
    "mode",
    "toolchain",
    "compression",
    "archiveCompression",
    ...(isApp ? ["moduleCompression"] : []),
    "commit",
    "buildTime",
  ]) {
    if (!bm[key] || !cm[key]) add("metadata", `${key} 信息缺失，显示未知`);
    else if (!["commit", "buildTime"].includes(key) && bm[key] !== cm[key])
      add(
        "compatibility",
        `${key} 不同：${bm[key]} → ${cm[key]}，差异不能全部归因为业务改动`,
      );
  }
  if (base.metadata.applicationId !== current.metadata.applicationId)
    fail("两份产物应用标识不同，不是兼容产物");
  const nested = files.filter(
    (f) => !f.expanded && /\.(zip|hap|hsp|app|jar)$/i.test(f.path),
  );
  if (nested.length)
    add(
      "incomplete",
      "嵌套归档按外层条目统计；内层文件、重复及模块分析不可用，未将内层压缩长度当作最终贡献",
      nested.map((f) => f.path),
    );
  const delta = current.size - base.size,
    growthPercent = base.size ? (delta / base.size) * 100 : null;
  if (!isInner && rules.budgetBytes !== null && delta > rules.budgetBytes)
    add("budget", `净增量超出预算 ${delta - rules.budgetBytes} 字节`);
  if (
    !isInner &&
    rules.growthPercent !== null &&
    growthPercent !== null &&
    growthPercent > rules.growthPercent
  )
    add("budget", `增长比例超过提醒值 ${rules.growthPercent}%`);
  if (!isInner && rules.budgetBytes === null)
    add("budget_unset", "未设置增量预算，不能自动判定通过");
  const inner =
    base.inner && current.inner
      ? comparePackages(base.inner, current.inner, input)
      : undefined;
  if (inner) {
    for (const finding of inner.findings)
      if (!["metadata", "compatibility"].includes(finding.kind))
        findings.push({
          ...finding,
          message: `HAP/HSP 内部：${finding.message}`,
        });
    add(
      "metric",
      "HAP/HSP 内部大小单独对账，不与 APP 外层占用相加；内层文件在 APP 中的最终压缩贡献不可用",
    );
    if (current.metadata.mode.includes(","))
      add(
        "compatibility",
        "内部模块包含不同构建模式，请核查 debug/release 配置",
      );
  }
  return {
    algorithm: isApp ? APP_ALGORITHM : ALGORITHM,
    rules,
    metric: isInner
      ? "HAP/HSP 内部：模块包文件长度合计；明细为各模块包内独立 ZIP 条目压缩占用，加模块包结构开销对账；不是 APP 最终压缩贡献，不与 APP 外层占用相加"
      : isApp
        ? "主指标：上传 APP 实际字节；模块占用为 APP 外层 ZIP 条目压缩长度；结构开销含 APP 签名、目录和容器头；内部文件统计独立对账"
        : "主指标：上传 HAP 实际字节；明细：ZIP 条目压缩占用；结构开销含签名、清单目录和容器头",
    capabilities: {
      metadata: isApp
        ? "pack.info + 内部 module.json + 人工补充"
        : "module.json + 人工补充",
      modules: isApp
        ? "实际 HAP/HSP 模块 + 配置目录规则"
        : "HAP 模块 + 配置目录规则",
      files: isApp
        ? "APP 外层及 HAP/HSP 内部清单分开统计，内容 SHA-256 比较"
        : "完整外层清单，内容 SHA-256 比较",
      architectures: "路径识别",
      compressed: "外层 ZIP 独立条目实测",
      nested:
        isApp && !isInner
          ? "展开一层 HAP/HSP；更深归档不可用（保留条目占用）"
          : "不可用（保留外层占用）",
      download: "不可用",
      installed: "不可用",
    },
    completeness:
      nested.length || inner?.completeness === "partial"
        ? "partial"
        : "complete",
    baseline: base.size,
    current: current.size,
    delta,
    growthPercent,
    positive: files.reduce((n, f) => n + Math.max(0, f.delta), 0),
    negative: files.reduce((n, f) => n + Math.min(0, f.delta), 0),
    overheadBaseline: base.overhead,
    overheadCurrent: current.overhead,
    overheadDelta: current.overhead - base.overhead,
    budgetRemaining:
      isInner || rules.budgetBytes === null ? null : rules.budgetBytes - delta,
    modules: aggregate(files, (f) => f.module),
    categories: aggregate(files, (f) => f.category),
    businessTypes: aggregate(files, (f) => `${f.group} × ${f.category}`),
    files,
    findings,
    baselineMetadata: bm,
    currentMetadata: cm,
    ...(inner ? { inner } : {}),
  };
}

/** Adapter contract: read(bytes, limits) returns size, sha256, metadata, overhead, and
 * entries [{path,size,raw,hash}]. size is independent compressed bytes at the chosen
 * archive boundary. Adapters with shared/unknown compression must expose a separate
 * metric before participating in this exact-byte comparison engine. */
export const packageAdapters = Object.freeze({
  app: Object.freeze({
    format: "app",
    platform: "HarmonyOS",
    algorithm: APP_ALGORITHM,
    read: readApp,
    capabilities: {
      metadata: true,
      modules: true,
      files: true,
      architectures: true,
      independentCompressedEntries: true,
      nested: true,
    },
  }),
  hap: Object.freeze({
    format: "hap",
    platform: "HarmonyOS",
    algorithm: ALGORITHM,
    read: readHap,
    capabilities: {
      metadata: true,
      modules: true,
      files: true,
      architectures: true,
      independentCompressedEntries: true,
      nested: false,
    },
  }),
});
export function getPackageAdapter(format) {
  const adapter = Object.hasOwn(packageAdapters, format)
    ? packageAdapters[format]
    : null;
  if (!adapter) throw new Error(`不支持的包格式：${format}`);
  return adapter;
}
