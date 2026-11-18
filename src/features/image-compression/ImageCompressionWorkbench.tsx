"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Progress, Space, Tag, Upload } from "antd";
import { DataTable } from "@/shared/data-table/DataTable";
import { DownloadOutlined, InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import type { CompressionRow, CompressionTask, Variant } from "@/lib/image-compression/types";
import styles from "./ImageCompressionWorkbench.module.css";

const size = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : `${(n / 1024).toFixed(2)} KiB`;
const saved = (before: number, after: number) => before ? `${((1 - after / before) * 100).toFixed(2)}%` : "0%";
const variants: { key: Variant; title: string; detail: string }[] = [
  { key: "png", title: "保留原格式", detail: "保留文件名与格式，适合直接替换资源。" },
  { key: "webp", title: "WebP 优先", detail: "严格无损编码；未变小或需保留元数据时使用原文件。" },
  { key: "smallest", title: "逐张择小", detail: "从原图、原格式优化和无损 WebP 中取最小。" },
];
const headers = () => ({ Authorization: `Bearer ${localStorage.getItem("hm_token") || ""}` });
async function request(route: string, init?: RequestInit) {
  const response = await fetch(`/api/image-compression/${route}`, { ...init, headers: { ...headers(), ...init?.headers }, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  return response;
}
const errorText = (e: unknown) => e instanceof Error ? e.message : "操作失败";

export function ImageCompressionWorkbench() {
  const [file, setFile] = useState<File | null>(null);
  const [task, setTask] = useState<CompressionTask | null>(null);
  const [available, setAvailable] = useState<{ ready: boolean; missing: string[] } | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState("");
  const [connectionLost, setConnectionLost] = useState(false);
  const [retry, setRetry] = useState(0);
  const downloadUrls = useRef(new Set<string>());
  const busy = uploading || task?.status === "running";
  const report = task?.report;

  useEffect(() => {
    let alive = true;
    void request("capabilities").then(r => r.json()).then(data => { if (alive) setAvailable(data); }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [retry]);
  useEffect(() => {
    const urls = downloadUrls.current;
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
  useEffect(() => {
    if (!task || task.status !== "running") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await (await request(`tasks/${task.id}`)).json();
        if (!alive) return;
        setConnectionLost(false);
        setTask(data.item);
        if (data.item.status === "running") timer = setTimeout(() => void poll(), 1500);
      } catch (e) {
        if (alive) { setError(errorText(e)); setConnectionLost(true); }
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [task?.id, task?.status, retry]);

  async function compress() {
    if (!file || busy) return;
    setUploading(true); setError(""); setTask(null); setConnectionLost(false);
    try {
      const data = await (await request("tasks", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file })).json();
      setTask(data.item);
    } catch (e) { setError(errorText(e)); }
    finally { setUploading(false); }
  }
  async function download(filename: string) {
    if (!task) return;
    setDownloading(filename); setError("");
    try {
      const response = await request(`tasks/${task.id}/${filename}`);
      const url = URL.createObjectURL(await response.blob());
      downloadUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url; link.download = `image-compression-${filename}`; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 60000);
    } catch (e) { setError(errorText(e)); }
    finally { setDownloading(""); }
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>RESOURCE LAB / LOSSLESS COMPRESSION</div>
        <div>
          <h1>图片资源压缩 <span className={styles.badge}>无损</span></h1>
          <p>让资源更轻，保留每一个像素。</p>
        </div>
      </header>
      {error && <Alert type="error" showIcon message={error} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => { setError(""); setRetry(v => v + 1); }}>重试连接</Button>} />}
      {available && !available.ready && <Alert type="warning" showIcon message="压缩服务尚未就绪" description={`请管理员安装服务端依赖：${available.missing.join("、")}。安装后点击重试。`} action={<Button onClick={() => setRetry(v => v + 1)}>重试</Button>} />}
      <section className={styles.uploadSection}>
        <div>
          <div className={styles.step}>01 / 上传资源</div>
          <h2>一张图片，或一整套资源</h2>
          <p>支持 PNG、JPG、JPEG、WebP，以及混合资源 ZIP，单次最多 50 MiB、500 张。目录和帧编号保持不变。</p>
          <p>每张静态图片解码为 RGBA 校验；动画 PNG / WebP 保留原文件。资源只在工作台服务器处理。</p>
          <Button type="primary" size="large" loading={uploading} disabled={!file || busy || !available?.ready} onClick={() => void compress()}>开始无损压缩</Button>
        </div>
        <Upload.Dragger accept=".png,.jpg,.jpeg,.webp,.zip" maxCount={1} disabled={busy} fileList={file ? [{ uid: "resource", name: file.name, status: "done" }] : []}
          beforeUpload={selected => {
            if (!/\.(png|jpe?g|webp|zip)$/i.test(selected.name) || selected.size > 50 * 1024 * 1024 || !selected.size) {
              setError("请选择不超过 50 MiB 的非空 PNG、JPG、JPEG、WebP 或 ZIP 文件"); return Upload.LIST_IGNORE;
            }
            setFile(selected); setError(""); return false;
          }} onRemove={() => { setFile(null); return true; }}>
          <p className="ant-upload-drag-icon"><InboxOutlined style={{ color: "#4c6fff" }} /></p>
          <p className="ant-upload-text">拖入资源，或点击选择</p>
          <p className="ant-upload-hint">ZIP 可混合放入 PNG、JPG、JPEG、WebP，可保留子目录</p>
        </Upload.Dragger>
      </section>
      {busy && <section className={styles.progress} aria-live="polite">
        <strong>{uploading ? "正在上传资源…" : connectionLost ? "连接中断，请重试连接获取任务状态" : `正在压缩并校验 ${task?.completed || 0} / ${task?.total || "—"}`}</strong>
        <Progress percent={task?.total ? Math.floor(task.completed / task.total * 100) : 0} status={connectionLost ? "exception" : "active"} strokeColor="#357c76" />
        <span>可以切换工作台入口，任务会继续执行。</span>
        {connectionLost && <Button onClick={() => { setTask(null); setConnectionLost(false); }}>返回上传</Button>}
      </section>}
      {task?.status === "failed" && <Alert type="error" showIcon message="本次压缩未完成" description={task.error} />}
      {report ? <>
        <div className={styles.resultHeading}>
          <div><div className={styles.step}>02 / 选择压缩结果</div><h2>{report.count} 张图片 · 原始合计 {size(report.originalBytes)}</h2></div>
          <Tag color="success">{report.verifiedCount} 张通过像素校验</Tag>
        </div>
        <div className={styles.variants}>
          {variants.map(({ key, title, detail }) => <article className={styles.variant} key={key}>
            <h3>{title}</h3><p>{detail}</p>
            <strong className={styles.size}>{size(report.variants[key].bytes)}</strong>
            <span className={styles.saving}>减少 {saved(report.originalBytes, report.variants[key].bytes)}</span>
            <small>下载 ZIP：{size(report.variants[key].zipBytes)}</small>
            <Button icon={<DownloadOutlined />} loading={downloading === `${key}.zip`} onClick={() => void download(`${key}.zip`)}>下载资源</Button>
          </article>)}
        </div>
        <Alert type="info" showIcon message="体积按图片文件合计统计，不等于安装包最终减少量。" description="WebP 结果可能包含保留原格式的图片；转换重名时自动补后缀，路径见 CSV；接入前请核对扩展名、帧序列引用与 App 解码支持。结果保留 24 小时，服务重启或刷新页面后需要重新上传。" />
        {!!report.duplicates.length && <section className={styles.duplicates}><h3>发现 {report.duplicates.length} 组重复图片</h3><p>全部文件均保留。可以复用资源引用，但需维持动画帧序和时长。</p>{report.duplicates.map((group, i) => <p key={i}>{group.join(" = ")}</p>)}</section>}
        <section className={styles.details}>
          <Space className={styles.detailsTitle}><h2>逐文件明细</h2><Button icon={<DownloadOutlined />} loading={downloading === "details.csv"} onClick={() => void download("details.csv")}>导出 CSV</Button></Space>
          <DataTable tableKey="image-compression-files" rowKey="name" dataSource={report.rows} size="small" pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
            { title: "资源路径", dataIndex: "name", width: 300, render: (name: string) => <span className={styles.filename}>{name}</span> },
            { title: "尺寸", width: 120, sorter: (left: CompressionRow, right: CompressionRow) => left.width * left.height - right.width * right.height, render: (_: unknown, row: CompressionRow) => `${row.width} × ${row.height}` },
            { title: "原始", dataIndex: "originalBytes", width: 110, render: size },
            { title: "保留原格式", dataIndex: "pngBytes", width: 120, render: size },
            { title: "WebP 优先", dataIndex: "webpBytes", width: 120, render: size },
            { title: "择小减幅", width: 110, sorter: (left: CompressionRow, right: CompressionRow) => (left.originalBytes ? 1 - left.smallestBytes / left.originalBytes : 0) - (right.originalBytes ? 1 - right.smallestBytes / right.originalBytes : 0), render: (_: unknown, row: CompressionRow) => saved(row.originalBytes, row.smallestBytes) },
            { title: "校验 / 说明", width: 180, sorter: (left: CompressionRow, right: CompressionRow) => Number(left.verified) - Number(right.verified), render: (_: unknown, row: CompressionRow) => <span>{row.verified ? "像素一致" : "原文件保留"}{row.note && ` · ${row.note}`}</span> },
          ]} />
        </section>
      </> : !busy && <section className={styles.placeholder}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="上传后查看三种方案的实际体积与压缩明细" /><p>压缩空间取决于原图。已优化过的索引色 PNG，进一步无损压缩的收益可能较小。</p></section>}
    </div>
  );
}
