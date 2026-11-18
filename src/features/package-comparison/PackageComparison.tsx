"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  FileZipOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  ANALYSIS_LABELS,
  FILE_LABELS,
  REVIEW_LABELS,
  SCENES,
  REPORT_SIZE_UNIT,
  sizeText,
} from "@/lib/package-comparison/types";
import type {
  Analysis,
  Artifact,
  Comparison,
  Explanation,
  FileExplanation,
  Metadata,
  PackageFile,
  PackageProject,
  PackageResult,
  PackageRules,
  ReviewStatus,
  SizeRow,
} from "@/lib/package-comparison/types";
import { DataTable } from "@/shared/data-table/DataTable";
import styles from "./PackageComparison.module.css";
import { GrowthAssessment } from "./GrowthAssessment";

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set(
    "Authorization",
    `Bearer ${localStorage.getItem("hm_token") || ""}`,
  );
  if (typeof init?.body === "string")
    headers.set("content-type", "application/json");
  const response = await fetch(`/api/package-comparison/${route}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (response.status === 401) {
    localStorage.removeItem("hm_token");
    throw new Error("登录已失效，请重新登录");
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `请求失败（${response.status}）`);
  return data as T;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";
const busyRun = (run?: Analysis) =>
  !!run && ["queued", "running"].includes(run.status);
const necessityLabels = {
  necessary: "必要",
  optimizable: "可优化",
  unconfirmed: "待确认",
};
const metaLabels: Record<string, string> = {
  applicationId: "应用标识",
  version: "版本",
  build: "构建号",
  module: "模块标识",
  commit: "提交标识",
  buildTime: "构建时间",
  channel: "渠道",
  variant: "产品变体",
  architectures: "目标架构",
  mode: "构建模式",
  toolchain: "工具链",
  compression: "压缩配置",
};

export function PackageComparisonWorkbench() {
  const [create, setCreate] = useState(false);
  return <PackageWorkspace createOpen={create} setCreateOpen={setCreate} />;
}
function PackageWorkspace({
  createOpen,
  setCreateOpen,
}: {
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const [projects, setProjects] = useState<PackageProject[]>([]),
    [tasks, setTasks] = useState<Comparison[]>([]),
    [selected, setSelected] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [historySearch, setHistorySearch] = useState("");
  const [limit, setLimit] = useState(0),
    [dirty, setDirty] = useState(false);
  const selectedRef = useRef<Comparison | null>(null),
    requestVersion = useRef(0);
  const select = (task: Comparison | null) => {
    selectedRef.current = task;
    setSelected(task);
  };
  const loadTasks = useCallback(async () => {
    const data = await request<{ items: Comparison[] }>("tasks");
    setTasks(data.items);
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      request<{ items: PackageProject[]; limits: { uploadBytes: number } }>(
        "projects",
      ),
      request<{ items: Comparison[] }>("tasks"),
    ])
      .then(([p, t]) => {
        if (alive) {
          setProjects(p.items);
          setLimit(p.limits.uploadBytes);
          setTasks(t.items);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void (async () => {
        const t = await request<{ items: Comparison[] }>("tasks");
        if (!alive) return;
        setTasks(t.items);
        const previous = selectedRef.current,
          version = requestVersion.current;
        if (previous && busyRun(previous.runs[0])) {
          const d = await request<{ item: Comparison }>(`tasks/${previous.id}`);
          if (
            alive &&
            selectedRef.current?.id === previous.id &&
            version === requestVersion.current
          )
            select(d.item);
        }
      })()
        .catch((e) => {
          if (alive) setError(errorText(e));
        })
        .finally(() => {
          polling = false;
        });
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
      requestVersion.current++;
    };
  }, []);
  const guard = (next: () => void) => {
    if (dirty)
      modal.confirm({
        title: "放弃未保存的说明？",
        content: "已保存的说明和审核历史会保留。",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: () => {
          setDirty(false);
          next();
        },
      });
    else next();
  };
  async function openTask(id: string) {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const d = await request<{ item: Comparison }>(`tasks/${id}`);
      if (version === requestVersion.current) {
        select(d.item);
        setDirty(false);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }
  function updated(task: Comparison) {
    requestVersion.current++;
    select(task);
    setDirty(false);
    void loadTasks().catch((e) => setError(errorText(e)));
  }
  return (
      <div className={styles.root}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>
              BUILD ARTIFACTS / SIZE COMPARISON
            </div>
            <h2>安装包体积对比</h2>
            <p>固定产物 · 字节对账 · 人工审核</p>
          </div>
          <div className={styles.actions}>
            <Button
              icon={<ReloadOutlined />}
              onClick={() =>
                void loadTasks().catch((e) => setError(errorText(e)))
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
            >
              新建包体对比
            </Button>
          </div>
        </header>
        {error && (
          <Alert
            style={{ marginBottom: 16 }}
            type="error"
            showIcon
            closable
            message={error}
            onClose={() => setError("")}
          />
        )}
        <div className={styles.layout}>
          <aside className={styles.history}>
            <h3>
              <HistoryOutlined /> 对比历史{" "}
              <span className={styles.muted}>最近 {tasks.length} 条</span>
            </h3>
            <Input
              placeholder="搜索任务、项目"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              allowClear
            />
            <div className={styles.historyList}>
              {tasks
                .filter((t) =>
                  `${t.title} ${t.projectId}`
                    .toLowerCase()
                    .includes(historySearch.toLowerCase()),
                )
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`${styles.historyItem} ${selected?.id === t.id ? styles.selected : ""}`}
                    onClick={() => guard(() => void openTask(t.id))}
                  >
                    <strong>{t.title}</strong>
                    <span className={styles.historyMeta}>
                      <Tag
                        color={
                          busyRun(t.runs[0])
                            ? "processing"
                            : t.runs[0]?.status === "failed"
                              ? "error"
                              : "default"
                        }
                      >
                        {ANALYSIS_LABELS[t.runs[0]?.status] || "未知"}
                      </Tag>
                      <Tag>{REVIEW_LABELS[t.reviewStatus]}</Tag>
                    </span>
                    <small>
                      {projects.find((p) => p.id === t.projectId)?.label ||
                        t.projectId}{" "}
                      · {new Date(t.createdAt).toLocaleDateString()}
                    </small>
                  </button>
                ))}
              {!tasks.length && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无对比记录"
                />
              )}
            </div>
          </aside>
          <main className={styles.content}>
            <Spin spinning={loading}>
              {selected ? (
                <PackageReport
                  key={selected.id}
                  task={selected}
                  onUpdated={updated}
                  onDirty={setDirty}
                />
              ) : (
                <div className={styles.empty}>
                  <FileZipOutlined style={{ fontSize: 42, color: "#498f81" }} />
                  <h3>选两份产物，追踪包体变化</h3>
                  <p className={styles.muted}>HarmonyOS APP / HAP 包体对比</p>
                  <Button type="primary" onClick={() => setCreateOpen(true)}>
                    创建第一份对比
                  </Button>
                </div>
              )}
            </Spin>
          </main>
        </div>
        <CreateComparison
          open={createOpen}
          projects={projects}
          uploadLimit={limit}
          onCancel={() => setCreateOpen(false)}
          onCreated={(task) => {
            setCreateOpen(false);
            guard(() => updated(task));
            message.success("对比任务已创建，正在排队分析");
          }}
        />
      </div>
  );

}

type CreateValues = {
  title: string;
  projectId: string;
  scene: string;
  owner: string;
  requirement?: string;
  scope?: string;
  budgetBytes?: number | null;
  growthPercent?: number | null;
  largeFileBytes?: number | null;
  fileGrowthBytes?: number | null;
  imageFileBytes?: number | null;
  compatibilityNote?: string;
  baselineMetadata?: Metadata;
  currentMetadata?: Metadata;
};
function CreateComparison({
  open,
  projects,
  uploadLimit,
  onCancel,
  onCreated,
}: {
  open: boolean;
  projects: PackageProject[];
  uploadLimit: number;
  onCancel: () => void;
  onCreated: (t: Comparison) => void;
}) {
  const [form] = Form.useForm<CreateValues>(),
    projectId = Form.useWatch("projectId", form);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [baselineId, setBaseline] = useState<string>(),
    [currentId, setCurrent] = useState<string>();
  const [uploading, setUploading] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [advanced, setAdvanced] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const version = useRef(0);
  useEffect(() => {
    const revision = ++version.current;
    setArtifacts([]);
    setBaseline(undefined);
    setCurrent(undefined);
    setError("");
    if (!project) return;
    const {
      budgetBytes,
      growthPercent,
      largeFileBytes,
      fileGrowthBytes,
      imageFileBytes,
      ...advancedRules
    } = project.rules;
    setAdvanced(JSON.stringify(advancedRules, null, 2));
    form.setFieldsValue({
      budgetBytes,
      growthPercent,
      largeFileBytes,
      fileGrowthBytes,
      imageFileBytes,
    });
    void request<{ items: Artifact[] }>(
      `artifacts?projectId=${encodeURIComponent(project.id)}`,
    )
      .then((d) => {
        if (revision === version.current) setArtifacts(d.items);
      })
      .catch((e) => {
        if (revision === version.current) setError(errorText(e));
      });
  }, [project, form]);
  async function upload(file: File, side: string) {
    if (!project) return;
    if (file.size > uploadLimit) {
      setError(`安装包不能超过 ${sizeText(uploadLimit, REPORT_SIZE_UNIT)}`);
      return;
    }
    const revision = version.current;
    setUploading(side);
    setError("");
    try {
      const d = await request<{ item: Artifact }>(
        `artifacts?projectId=${encodeURIComponent(project.id)}`,
        {
          method: "POST",
          headers: {
            "x-file-name": encodeURIComponent(file.name),
            "content-type": "application/octet-stream",
          },
          body: file,
        },
      );
      if (revision === version.current) {
        setArtifacts((a) => [d.item, ...a]);
        (side === "baseline" ? setBaseline : setCurrent)(d.item.id);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading("");
    }
  }
  async function create(values: CreateValues) {
    setError("");
    if (!baselineId || !currentId) {
      setError("请选择基准和当前两份产物");
      return;
    }
    setSaving(true);
    try {
      const rules = {
        ...JSON.parse(advanced),
        budgetBytes: values.budgetBytes ?? null,
        growthPercent: values.growthPercent ?? null,
        largeFileBytes: values.largeFileBytes ?? null,
        fileGrowthBytes: values.fileGrowthBytes ?? null,
        imageFileBytes: values.imageFileBytes ?? null,
      };
      const d = await request<{ item: Comparison }>("tasks", {
        method: "POST",
        body: JSON.stringify({
          ...values,
          scope: (values.scope || "")
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
          rules,
          baselineId,
          currentId,
        }),
      });
      onCreated(d.item);
      form.resetFields();
      setBaseline(undefined);
      setCurrent(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const artifactSelector = (side: "baseline" | "current", label: string) => {
    const id = side === "baseline" ? baselineId : currentId,
      item = artifacts.find((a) => a.id === id);
    return (
      <div className={styles.upload}>
        <label>{label}</label>
        <Select
          aria-label={label}
          style={{ width: "100%" }}
          showSearch
          optionFilterProp="label"
          placeholder="选择已上传的 APP / HAP"
          value={id}
          disabled={!project || !!uploading || saving}
          onChange={side === "baseline" ? setBaseline : setCurrent}
          options={artifacts
            .filter((a) => !a.purgedAt)
            .map((a) => ({
              value: a.id,
              label: `${a.name} · ${sizeText(a.size, REPORT_SIZE_UNIT)} · ${new Date(a.createdAt).toLocaleString()}`,
            }))}
        />
        <input
          aria-label={`上传${label}`}
          type="file"
          accept=".app,.hap"
          disabled={!project || !!uploading || saving}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file, side);
          }}
        />
        {uploading === side && (
          <Space>
            <Spin size="small" />
            上传并校验文件内容…
          </Space>
        )}
        {item && (
          <div className={styles.muted}>
            {item.metadata.applicationId} ·{" "}
            {item.metadata.version || "版本未知"} · {item.metadata.module}
            <br />
            固定产物：{item.id}
          </div>
        )}
      </div>
    );
  };
  return (
    <Modal
      open={open}
      title="新建包体对比"
      width={920}
      onCancel={onCancel}
      maskClosable={!saving && !uploading}
      closable={!saving && !uploading}
      footer={
        <Space>
          <Button onClick={onCancel} disabled={saving || !!uploading}>
            取消
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!project || !!uploading}
            onClick={() => form.submit()}
          >
            创建并开始分析
          </Button>
        </Space>
      }
    >
      <p className={styles.muted}>
        支持 release .app 整包或 .hap，单包上限{" "}
        {uploadLimit ? sizeText(uploadLimit, REPORT_SIZE_UNIT) : "读取中"}
        。两份产物需为相同格式、项目与应用标识；构建差异会保留在报告。
      </p>
      {error && (
        <Alert
          showIcon
          type="error"
          message={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ scene: "custom" }}
        onFinish={create}
        disabled={saving}
      >
        <div className={styles.formGrid}>
          <Form.Item
            name="projectId"
            label="项目"
            rules={[{ required: true, message: "请选择项目" }]}
          >
            <Select
              placeholder="请选择项目"
              disabled={!!uploading || saving}
              options={projects.map((p) => ({ value: p.id, label: p.label }))}
            />
          </Form.Item>
          <Form.Item name="scene" label="对比场景" rules={[{ required: true }]}>
            <Select
              options={Object.entries(SCENES).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="title"
            label="任务名称"
            rules={[{ required: true, message: "请输入任务名称" }]}
          >
            <Input maxLength={160} placeholder="例如：版本发布包体检查" />
          </Form.Item>
          <Form.Item
            name="owner"
            label="负责人"
            rules={[{ required: true, message: "请输入负责人" }]}
          >
            <Input maxLength={120} />
          </Form.Item>
        </div>
        <div className={styles.formGrid}>
          {artifactSelector("baseline", "基准产物")}
          {artifactSelector("current", "当前产物")}
        </div>
        <div className={styles.formGrid}>
          <Form.Item name="requirement" label="关联需求">
            <Input placeholder="需求编号或链接" />
          </Form.Item>
          <Form.Item name="scope" label="需求影响范围">
            <Input placeholder="模块标识或路径前缀，用逗号分隔" />
          </Form.Item>
        </div>
        <Collapse
          items={[
            {
              key: "metadata",
              label: "补充构建信息与可比性说明",
              children: (
                <>
                  <p className={styles.muted}>
                    包内已读取的信息优先，不能被手动覆盖。无法读取的信息留空即为“未知”。
                  </p>
                  <div className={styles.formGrid}>
                    {(["baselineMetadata", "currentMetadata"] as const).map(
                      (side, i) => (
                        <div key={side}>
                          <h4>{i ? "当前产物" : "基准产物"}</h4>
                          {Object.entries(metaLabels)
                            .filter(
                              ([k]) => !["applicationId", "module"].includes(k),
                            )
                            .map(([key, label]) => (
                              <Form.Item
                                key={key}
                                name={[side, key]}
                                label={label}
                              >
                                <Input maxLength={512} />
                              </Form.Item>
                            ))}
                        </div>
                      ),
                    )}
                  </div>
                  <Form.Item name="compatibilityNote" label="配置差异说明">
                    <Input.TextArea
                      rows={3}
                      placeholder="说明渠道、构建模式、架构等差异及其影响"
                    />
                  </Form.Item>
                </>
              ),
            },
            {
              key: "rules",
              label: "预算、阈值与项目规则",
              children: (
                <>
                  <p className={styles.muted}>
                    字节值必须为整数。留空表示未设置，0
                    表示零预算；检查只提示，结论由人工审核。
                  </p>
                  <div className={styles.formGrid}>
                    {(
                      [
                        ["budgetBytes", "净增量预算（字节）"],
                        ["growthPercent", "增长比例提醒（%）"],
                        ["largeFileBytes", "当前文件阈值（压缩字节）"],
                        ["fileGrowthBytes", "文件增长阈值（压缩字节）"],
                        ["imageFileBytes", "单张图片提醒值（原始文件字节）"],
                      ] as const
                    ).map(([name, label]) => (
                      <Form.Item key={name} name={name} label={label}>
                        <InputNumber
                          min={0}
                          precision={name === "growthPercent" ? 2 : 0}
                          style={{ width: "100%" }}
                          placeholder="未设置"
                        />
                      </Form.Item>
                    ))}
                  </div>
                  <label>
                    规则快照（JSON，可调整单位、架构、模块与业务分组、分类优先级）
                  </label>
                  <Input.TextArea
                    aria-label="规则快照"
                    rows={12}
                    value={advanced}
                    onChange={(e) => setAdvanced(e.target.value)}
                    style={{ fontFamily: "monospace", marginTop: 8 }}
                  />
                  <p className={styles.muted}>
                    groups/modules：
                    {`[{"prefix":"resources/","name":"业务名称","owner":"负责人"}]`}
                    ；categories：
                    {`[{"category":"模型","extensions":["onnx"],"prefix":"resources/"}]`}
                    。按数组顺序优先匹配，未匹配归入默认分类。
                  </p>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}

function PackageReport({
  task,
  onUpdated,
  onDirty,
}: {
  task: Comparison;
  onUpdated: (t: Comparison) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { message } = App.useApp(),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [notes, setNotes] = useState<Explanation>(task.explanation),
    [dirty, setDirty] = useState(false),
    [reviewReason, setReviewReason] = useState(""),
    [version, setVersion] = useState(task.runs[0].version);
  const [editing, setEditing] = useState<PackageFile | null>(null),
    [fileNote, setFileNote] = useState<FileExplanation | null>(null);
  useEffect(() => {
    setNotes(task.explanation);
    setDirty(false);
    onDirty(false);
    setVersion(task.runs[0].version);
  }, [task.revision, task.runs[0].id]); // New persisted version replaces the editor; polling only refreshes active analyses.
  function change(next: Explanation) {
    setNotes(next);
    setDirty(true);
    onDirty(true);
  }
  const run = task.runs.find((r) => r.version === version) || task.runs[0],
    result = run.result,
    currentVersion = run.id === task.runs[0].id;
  const unit = REPORT_SIZE_UNIT,
    format = (n: number | null, digits = 2) => sizeText(n, unit, digits);
  async function mutate(action: string, body: Record<string, unknown> = {}) {
    setSaving(true);
    setError("");
    try {
      const d = await request<{ item: Comparison }>(
        `tasks/${task.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: task.revision,
            analysisId: task.runs[0].id,
            ...body,
          }),
        },
      );
      onUpdated(d.item);
      setDirty(false);
      onDirty(false);
      setReviewReason("");
      message.success("已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function download(format: "md" | "csv") {
    setError("");
    try {
      const response = await fetch(
        `/api/package-comparison/tasks/${task.id}/export?format=${format}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("hm_token") || ""}`,
          },
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error || "导出失败");
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = `包体对比-${task.id}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    }
  }
  function editFile(file: PackageFile) {
    setEditing(file);
    setFileNote(
      notes.files?.[file.key] || {
        purpose: "",
        necessity: "unconfirmed",
        optimization: "",
        reason: "",
        contentHash: file.currentHash || file.baselineHash,
      },
    );
  }
  const warningCount =
    [...(result?.files || []), ...(result?.inner?.files || [])].filter(
      (f) =>
        f.delta > 0 &&
        (!notes.files?.[f.key]?.purpose ||
          notes.files[f.key].necessity === "unconfirmed"),
    ).length || 0;
  const statTable = (rows: SizeRow[]) => (
    <DataTable
      tableKey="package-size-breakdown"
      size="small"
      rowKey="name"
      dataSource={rows}
      pagination={{ pageSize: 15, showSizeChanger: true }}
      columns={[
        { title: "名称", dataIndex: "name" },
        {
          title: "状态",
          dataIndex: "status",
          render: (s: keyof typeof FILE_LABELS) => FILE_LABELS[s],
        },
        {
          title: `基准 (${unit})`,
          dataIndex: "baseline",
          render: (n) => format(n, 3),
        },
        {
          title: `当前 (${unit})`,
          dataIndex: "current",
          render: (n) => format(n, 3),
        },
        {
          title: "净增量",
          dataIndex: "delta",
          render: (n) => (
            <span className={n > 0 ? styles.positive : styles.negative}>
              {format(n, 3)}
            </span>
          ),
        },
        {
          title: "变化比例",
          sorter: (left: SizeRow, right: SizeRow) => {
            const ratio = (row: SizeRow) =>
              row.baseline ? row.delta / row.baseline : row.current ? Number.POSITIVE_INFINITY : 0;
            return ratio(left) - ratio(right);
          },
          render: (_, r) =>
            r.baseline
              ? `${((r.delta / r.baseline) * 100).toFixed(2)}%`
              : r.current
                ? "新增"
                : "—",
        },
      ]}
    />
  );
  return (
    <>
      <div className={styles.reportTitle}>
        <div>
          <h3>{task.title}</h3>
          <Space wrap>
            <Tag>{SCENES[task.input.scene as keyof typeof SCENES]}</Tag>
            <Tag
              color={
                task.reviewStatus === "approved"
                  ? "success"
                  : task.reviewStatus === "rejected"
                    ? "error"
                    : "default"
              }
            >
              {REVIEW_LABELS[task.reviewStatus]}
            </Tag>
            <span className={styles.muted}>
              负责人：{task.input.owner} · 说明 v
              {task.explanationVersion ?? task.revision}
            </span>
          </Space>
        </div>
        <div className={styles.actions}>
          <Select
            aria-label="分析版本"
            value={run.version}
            disabled={dirty}
            onChange={setVersion}
            options={task.runs.map((r) => ({
              value: r.version,
              label: `分析 v${r.version} · ${ANALYSIS_LABELS[r.status]}`,
            }))}
          />
          <Button
            loading={saving}
            disabled={
              busyRun(task.runs[0]) ||
              dirty ||
              !!task.baseline?.purgedAt ||
              !!task.current?.purgedAt
            }
            onClick={() => void mutate("retry")}
          >
            重新分析
          </Button>
          <Dropdown
            menu={{
              items: [
                {
                  key: "md",
                  label: "Markdown 报告",
                  onClick: () => void download("md"),
                },
                {
                  key: "csv",
                  label: "CSV 完整变更明细",
                  onClick: () => void download("csv"),
                },
              ],
            }}
            disabled={!result || !currentVersion || dirty}
          >
            <Button icon={<DownloadOutlined />}>导出</Button>
          </Dropdown>
        </div>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 12 }}
        />
      )}
      {!currentVersion && (
        <Alert
          type="info"
          showIcon
          message="正在查看历史分析。人工说明与审核操作仅适用于最新版本；历史审核见审核记录。"
        />
      )}
      {(task.baseline?.purgedAt || task.current?.purgedAt) && (
        <Alert
          type="warning"
          showIcon
          message="原始包已按保留策略清理，结果仍可查看和导出，复算能力受限。"
        />
      )}
      {busyRun(run) && (
        <div className={styles.section}>
          <h3>{ANALYSIS_LABELS[run.status]}</h3>
          <Progress percent={run.progress} status="active" />
          <p className={styles.muted}>
            后台执行内容校验、分类、文件比较和检查；关闭页面后任务继续。
          </p>
        </div>
      )}
      {run.status === "failed" && (
        <Alert
          type="error"
          showIcon
          message="分析失败"
          description={run.error || "请重试或检查产物"}
        />
      )}
      {result && (
        <>
          <div className={styles.metrics}>
            {[
              ["基准包体", result.baseline],
              ["当前包体", result.current],
              ["净增量", result.delta],
              ["预算剩余", result.budgetRemaining],
            ].map(([label, value]) => (
              <div key={String(label)} className={styles.metric}>
                <span>{String(label)}</span>
                <strong
                  className={
                    label === "净增量"
                      ? Number(value) > 0
                        ? styles.positive
                        : styles.negative
                      : undefined
                  }
                >
                  {value === null ? "未设置" : format(Number(value))}
                </strong>
              </div>
            ))}
          </div>
          <div className={styles.muted}>
            增长比例：
            {result.growthPercent === null
              ? "新增"
              : `${result.growthPercent.toFixed(2)}%`}{" "}
            · 1 KB = 1,024 字节 · {ANALYSIS_LABELS[run.status]} ·{" "}
            {result.algorithm}
          </div>
          <div className={styles.reconcile}>
            正向增长 {format(result.positive, 3)} ＋ 缩小/删除{" "}
            {format(result.negative, 3)} ＋ 结构开销变化{" "}
            {format(result.overheadDelta, 3)} ＝ 净增量{" "}
            {format(result.delta, 3)}
            <br />
            新增文件总大小不等于产物净增量。{result.metric}。
          </div>
          <GrowthAssessment
            result={result}
            notes={currentVersion ? notes : {}}
            onEdit={editFile}
            editable={currentVersion && !saving}
          />
          <Tabs
            items={[
              {
                key: "overview",
                label: "总览与模块",
                children: (
                  <>
                    <Descriptions
                      size="small"
                      bordered
                      column={2}
                      items={[
                        {
                          key: "base",
                          label: "基准产物",
                          children: (
                            <div>
                              {task.baseline?.name}
                              <div className={styles.muted}>
                                {task.baselineId}
                              </div>
                            </div>
                          ),
                        },
                        {
                          key: "current",
                          label: "当前产物",
                          children: (
                            <div>
                              {task.current?.name}
                              <div className={styles.muted}>
                                {task.currentId}
                              </div>
                            </div>
                          ),
                        },
                        {
                          key: "requirement",
                          label: "关联需求",
                          children: task.input.requirement || "未填写",
                        },
                        {
                          key: "scope",
                          label: "需求范围",
                          children: task.input.scope.join("、") || "未声明",
                        },
                        {
                          key: "budget",
                          label: "增量预算",
                          children:
                            result.rules.budgetBytes === null
                              ? "未设置"
                              : format(result.rules.budgetBytes),
                        },
                        {
                          key: "overhead",
                          label: "结构开销",
                          children: `${format(result.overheadBaseline)} → ${format(result.overheadCurrent)}`,
                        },
                      ]}
                    />
                    <h4>模块压缩占用</h4>
                    {statTable(result.modules)}
                    <p className={styles.muted}>
                      模块合计 + 结构开销 =
                      上传产物实际大小。签名和容器头在结构开销中对账。
                    </p>
                    <h4>构建信息与可比性</h4>
                    <DataTable
                      tableKey="package-metadata"
                      size="small"
                      pagination={false}
                      rowKey="name"
                      dataSource={[
                        ...new Set([
                          ...Object.keys(metaLabels),
                          ...Object.keys(result.baselineMetadata),
                          ...Object.keys(result.currentMetadata),
                        ]),
                      ].map((name) => ({
                        name,
                        baseline: result.baselineMetadata[name] || "未知",
                        current: result.currentMetadata[name] || "未知",
                      }))}
                      columns={[
                        {
                          title: "字段",
                          dataIndex: "name",
                          render: (k) => metaLabels[k] || k,
                        },
                        { title: "基准", dataIndex: "baseline" },
                        { title: "当前", dataIndex: "current" },
                      ]}
                    />
                    <p>
                      配置差异说明：{task.input.compatibilityNote || "未填写"}
                    </p>
                    <Collapse
                      items={[
                        {
                          key: "rules",
                          label: "适配器能力与规则快照",
                          children: (
                            <>
                              <Descriptions
                                column={1}
                                items={Object.entries(result.capabilities).map(
                                  ([key, value]) => ({
                                    key,
                                    label: key,
                                    children: value,
                                  }),
                                )}
                              />
                              <pre style={{ whiteSpace: "pre-wrap" }}>
                                {JSON.stringify(result.rules, null, 2)}
                              </pre>
                            </>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: "categories",
                label: "分类与业务",
                children: (
                  <>
                    <h4>文件类型 · ZIP 压缩占用</h4>
                    {statTable(result.categories)}
                    <h4>业务分组 × 文件类型</h4>
                    {statTable(result.businessTypes)}
                    <p className={styles.muted}>
                      分类互斥，未匹配内容保留。各表合计均需加结构开销{" "}
                      {format(result.overheadCurrent)} 与当前包体对账。
                    </p>
                  </>
                ),
              },
              {
                key: "files",
                label: `文件明细 (${result.files.filter((f) => f.status !== "unchanged").length})`,
                children: (
                  <FileTable
                    files={result.files}
                    notes={currentVersion ? notes : {}}
                    onEdit={editFile}
                    editable={currentVersion && !saving}
                  />
                ),
              },
              ...(result.inner
                ? [
                    {
                      key: "inner",
                      label: `HAP/HSP 内部 (${result.inner.files.filter((f) => f.status !== "unchanged").length})`,
                      children: (
                        <>
                          <Alert
                            type="info"
                            showIcon
                            message="内部模块包统计，不与 APP 外层占用相加"
                            description={result.inner.metric}
                          />
                          <div className={styles.reconcile}>
                            模块包合计：{format(result.inner.baseline)} →{" "}
                            {format(result.inner.current)}
                            {" · "}净增量：{format(result.inner.delta, 3)}
                            {" · "}内部结构开销：
                            {format(result.inner.overheadBaseline, 3)} →{" "}
                            {format(result.inner.overheadCurrent, 3)}
                          </div>
                          <Tabs
                            items={[
                              {
                                key: "inner-files",
                                label: "内部文件明细",
                                children: (
                                  <FileTable
                                    files={result.inner.files}
                                    notes={currentVersion ? notes : {}}
                                    onEdit={editFile}
                                    editable={currentVersion && !saving}
                                  />
                                ),
                              },
                              {
                                key: "inner-categories",
                                label: "内部模块与分类",
                                children: (
                                  <>
                                    <h4>模块内条目压缩占用</h4>
                                    {statTable(result.inner.modules)}
                                    <h4>文件类型</h4>
                                    {statTable(result.inner.categories)}
                                    <h4>业务分组 × 文件类型</h4>
                                    {statTable(result.inner.businessTypes)}
                                    <p className={styles.muted}>
                                      各表合计 + 内部结构开销 = HAP/HSP
                                      模块包长度合计。
                                    </p>
                                  </>
                                ),
                              },
                            ]}
                          />
                        </>
                      ),
                    },
                  ]
                : []),
              {
                key: "findings",
                label: `检查提示 (${result.findings.length})`,
                children: (
                  <>
                    <Alert
                      type={
                        result.completeness === "partial" ? "warning" : "info"
                      }
                      showIcon
                      message="提示供负责人核查，不代表文件可删除或增量合理"
                      description="重复按内容判断；潜在冗余不能直接作为实际节省空间。嵌套包的内层占用不计入外层实测。"
                    />
                    <DataTable
                      tableKey="package-findings"
                      rowKey={(_, i) => String(i)}
                      showHeader={false}
                      size="small"
                      pagination={{ pageSize: 20, showSizeChanger: true }}
                      dataSource={result.findings}
                      columns={[
                        {
                          sorter: (left, right) => left.message.localeCompare(right.message, "zh"),
                          render: (_, f) => (
                            <div className={styles.finding}>
                              <strong>{f.message}</strong>
                              {f.paths.map((p) => (
                                <div key={p} className={styles.path}>
                                  {p}
                                </div>
                              ))}
                            </div>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: "review",
                label: "说明与审核",
                children: (
                  <>
                    <Alert
                      type="warning"
                      showIcon
                      message={`${warningCount} 个正向增长文件待补充用途或必要性；${result.findings.length} 条检查提示需核查`}
                      description="请在文件明细填写关键文件用途。系统只生成统计和提示，审核结论由负责人确认。"
                    />
                    {currentVersion && (
                      <>
                        <div className={styles.notes}>
                          <div>
                            <label>增量来源、需求范围与用途</label>
                            <Input.TextArea
                              aria-label="增量来源与用途"
                              value={notes.summary}
                              rows={5}
                              maxLength={4000}
                              onChange={(e) =>
                                change({ ...notes, summary: e.target.value })
                              }
                            />
                          </div>
                          <div>
                            <label>已做优化</label>
                            <Input.TextArea
                              aria-label="已做优化"
                              value={notes.optimization}
                              rows={2}
                              maxLength={4000}
                              onChange={(e) =>
                                change({
                                  ...notes,
                                  optimization: e.target.value,
                                })
                              }
                            />
                            <label>保留原因／可比性与检查项核查结论</label>
                            <Input.TextArea
                              aria-label="保留原因"
                              value={notes.retentionReason}
                              rows={2}
                              maxLength={4000}
                              onChange={(e) =>
                                change({
                                  ...notes,
                                  retentionReason: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <Space style={{ marginTop: 14 }}>
                          <Button
                            type="primary"
                            loading={saving}
                            disabled={!dirty}
                            onClick={() =>
                              void mutate("explanation", { explanation: notes })
                            }
                          >
                            保存说明{dirty ? "（未保存）" : ""}
                          </Button>
                          <span className={styles.muted}>
                            修改说明后，旧审核保留为历史，当前状态恢复草稿。
                          </span>
                        </Space>
                        <div className={styles.section}>
                          <h4>人工审核</h4>
                          <Input.TextArea
                            aria-label="审核原因"
                            rows={2}
                            value={reviewReason}
                            maxLength={4000}
                            onChange={(e) => setReviewReason(e.target.value)}
                            placeholder="填写提交说明或审核结论的原因（必填）"
                          />
                          <Space wrap style={{ marginTop: 12 }}>
                            {(task.reviewStatus === "pending"
                              ? [
                                  ["needs_info", "需补充"],
                                  ["approved", "通过"],
                                  ["rejected", "不通过"],
                                ]
                              : ["draft", "needs_info", "rejected"].includes(
                                    task.reviewStatus,
                                  )
                                ? [["pending", "提交审核"]]
                                : []
                            ).map(([status, label]) => (
                              <Button
                                key={status}
                                loading={saving}
                                disabled={
                                  dirty ||
                                  !reviewReason.trim() ||
                                  !notes.summary?.trim()
                                }
                                type={
                                  status === "pending" || status === "approved"
                                    ? "primary"
                                    : "default"
                                }
                                danger={status === "rejected"}
                                onClick={() =>
                                  void mutate("review", {
                                    status,
                                    reason: reviewReason,
                                  })
                                }
                              >
                                {label}
                              </Button>
                            ))}
                          </Space>
                        </div>
                      </>
                    )}
                    <h4>审核历史（绑定固定产物与版本）</h4>
                    <DataTable
                      tableKey="package-reviews"
                      size="small"
                      rowKey="id"
                      expandable={{
                        expandedRowRender: (r) => (
                          <div>
                            <p>
                              增量来源与用途：
                              {r.explanation?.summary || "未填写"}
                            </p>
                            <p>
                              已做优化：
                              {r.explanation?.optimization || "未填写"}
                            </p>
                            <p>
                              保留原因：
                              {r.explanation?.retentionReason || "未填写"}
                            </p>
                            {Object.entries(r.explanation?.files || {}).map(
                              ([key, n]) => (
                                <p key={key}>
                                  {key}：{n.purpose} ·{" "}
                                  {necessityLabels[n.necessity]} · {n.reason}
                                </p>
                              ),
                            )}
                          </div>
                        ),
                      }}
                      dataSource={task.reviews || []}
                      pagination={{ pageSize: 10 }}
                      columns={[
                        {
                          title: "状态",
                          dataIndex: "status",
                          render: (s: ReviewStatus) => REVIEW_LABELS[s],
                        },
                        { title: "审核人", dataIndex: "actorName" },
                        {
                          title: "版本",
                          sorter: (left, right) =>
                            left.analysisVersion - right.analysisVersion ||
                            left.explanationVersion - right.explanationVersion,
                          render: (_, r) =>
                            `分析 v${r.analysisVersion} / 说明 v${r.explanationVersion}`,
                        },
                        { title: "原因", dataIndex: "reason" },
                        {
                          title: "时间",
                          dataIndex: "createdAt",
                          render: (t) => new Date(t).toLocaleString(),
                        },
                      ]}
                    />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
      <Modal
        title={editing ? `文件说明 · ${editing.name}` : "文件说明"}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => {
          if (editing && fileNote) {
            change({
              ...notes,
              files: { ...notes.files, [editing.key]: fileNote },
            });
            setEditing(null);
          }
        }}
        okText="应用到待保存说明"
      >
        {editing && fileNote && (
          <>
            <p className={styles.path}>{editing.path}</p>
            <label>用途</label>
            <Input.TextArea
              aria-label="文件用途"
              value={fileNote.purpose}
              maxLength={4000}
              onChange={(e) =>
                setFileNote({ ...fileNote, purpose: e.target.value })
              }
            />
            <label>必要性</label>
            <Select
              aria-label="文件必要性"
              style={{ width: "100%", margin: "8px 0 12px" }}
              value={fileNote.necessity}
              options={Object.entries(necessityLabels).map(
                ([value, label]) => ({ value, label }),
              )}
              onChange={(necessity) => setFileNote({ ...fileNote, necessity })}
            />
            <label>已做优化</label>
            <Input.TextArea
              value={fileNote.optimization}
              maxLength={4000}
              onChange={(e) =>
                setFileNote({ ...fileNote, optimization: e.target.value })
              }
            />
            <label>保留原因</label>
            <Input.TextArea
              value={fileNote.reason}
              maxLength={4000}
              onChange={(e) =>
                setFileNote({ ...fileNote, reason: e.target.value })
              }
            />
            <p className={styles.muted}>
              确认后仍需在“说明与审核”页签保存。文件内容变化时需重新确认。
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
function FileTable({
  files,
  notes,
  onEdit,
  editable,
}: {
  files: PackageFile[];
  notes: Explanation;
  onEdit: (f: PackageFile) => void;
  editable: boolean;
}) {
  const [query, setQuery] = useState(""),
    [filters, setFilters] = useState<Record<string, string | undefined>>({}),
    [view, setView] = useState("growth");
  const changedFiles = useMemo(
    () => files.filter((f) => f.status !== "unchanged"),
    [files],
  );
  const visible = useMemo(
    () =>
      changedFiles
        .filter(
          (f) =>
            f.path.toLowerCase().includes(query.toLowerCase()) &&
            Object.entries(filters).every(
              ([k, v]) => !v || f[k as keyof PackageFile] === v,
            ) &&
            (view === "native"
              ? /\.(so|dylib)$/i.test(f.path)
              : view === "shrink"
                ? f.delta < 0
                : view === "removed"
                  ? f.status === "removed"
                  : true),
        )
        .sort((a, b) =>
          view === "largest"
            ? b.current - a.current
            : view === "shrink"
              ? a.delta - b.delta
              : b.delta - a.delta,
        ),
    [changedFiles, query, filters, view],
  );
  const columns: ColumnsType<PackageFile> = [
    {
      title: "路径 / 模块 / 业务",
      key: "path",
      sorter: (left, right) => left.path.localeCompare(right.path, "zh"),
      width: 320,
      render: (_, f) => (
        <>
          <div className={styles.path}>{f.path}</div>
          <span className={styles.muted}>
            {f.module} · {f.group}
            {f.owner ? ` · ${f.owner}` : ""}
          </span>
        </>
      ),
    },
    { title: "类型", dataIndex: "category", width: 100 },
    {
      title: "架构",
      dataIndex: "architecture",
      width: 110,
      render: (v) => v || "—",
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 70,
      render: (s: keyof typeof FILE_LABELS) => FILE_LABELS[s],
    },
    ...(["baseline", "current", "delta"] as const).map((key, i) => ({
      title: ["基准压缩", "当前压缩", "净增量"][i],
      dataIndex: key,
      width: 130,
      render: (n: number) => (
        <span
          title={`${n} 字节`}
          className={
            key === "delta"
              ? n > 0
                ? styles.positive
                : styles.negative
              : undefined
          }
        >
          {sizeText(n, REPORT_SIZE_UNIT, 3)}
        </span>
      ),
    })),
    {
      title: "解压大小（当前）",
      dataIndex: "currentRaw",
      width: 140,
      render: (n) => sizeText(n, REPORT_SIZE_UNIT, 3),
    },
    {
      title: "用途与必要性",
      key: "notes",
      sorter: (left, right) =>
        (notes.files?.[left.key]?.purpose || "").localeCompare(notes.files?.[right.key]?.purpose || "", "zh"),
      width: 200,
      render: (_, f) => {
        const n = notes.files?.[f.key],
          stale = n && n.contentHash !== (f.currentHash || f.baselineHash);
        return (
          <>
            <div>{n?.purpose || "待补充"}</div>
            <Tag>
              {stale
                ? "内容已变化，需重新确认"
                : necessityLabels[n?.necessity || "unconfirmed"]}
            </Tag>
            {editable && (
              <Button size="small" type="link" onClick={() => onEdit(f)}>
                填写说明
              </Button>
            )}
          </>
        );
      },
    },
  ];
  return (
    <>
      <p className={styles.muted}>
        明细为当前统计范围内的 ZIP
        条目压缩占用；解压大小单独展示。相同大小但内容变化仍标记为修改。
      </p>
      <div className={styles.filters}>
        <Input
          aria-label="搜索文件路径"
          placeholder="搜索完整路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <Select
          aria-label="文件视图"
          value={view}
          onChange={setView}
          options={[
            { value: "growth", label: "正向增量排序" },
            { value: "shrink", label: "缩小 / 删除" },
            { value: "removed", label: "已删除" },
            { value: "largest", label: "当前最大文件" },
            { value: "native", label: "有改动的原生库" },
          ]}
        />
        {(
          ["module", "group", "category", "architecture", "status"] as const
        ).map((key, i) => (
          <Select
            key={key}
            aria-label={
              ["模块筛选", "业务筛选", "类型筛选", "架构筛选", "状态筛选"][i]
            }
            placeholder={["模块", "业务", "类型", "架构", "状态"][i]}
            allowClear
            value={filters[key]}
            onChange={(v) => setFilters({ ...filters, [key]: v })}
            options={[...new Set(changedFiles.map((f) => f[key]))]
              .filter(Boolean)
              .map((value) => ({
                value,
                label:
                  key === "status"
                    ? FILE_LABELS[value as keyof typeof FILE_LABELS]
                    : value,
              }))}
          />
        ))}
      </div>
      <DataTable
        tableKey="package-files"
        rowKey="key"
        size="small"
        columns={columns}
        dataSource={visible}
        pagination={{
          pageSize: 30,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 个文件`,
        }}
      />
    </>
  );
}
