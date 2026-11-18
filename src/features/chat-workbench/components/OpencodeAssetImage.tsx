"use client";

import { DownloadOutlined } from "@ant-design/icons";
import { App, Spin } from "antd";
import { useEffect, useState } from "react";
import {
  downloadOpencodeAsset,
  fetchOpencodeAssetBlob,
  filenameFromAssetPath,
  type AssetAuthMode,
} from "@/lib/opencode/opencode-asset-download";
import styles from "./OpencodeAssetImage.module.css";

type Props = {
  path: string;
  alt?: string;
  className?: string;
  /** 管理后台请求记录等场景使用 x-admin-secret 拉取资源 */
  authMode?: AssetAuthMode;
};

export function OpencodeAssetImage(props: Props) {
  const authMode = props.authMode || "user";
  const { message } = App.useApp();
  const [src, setSrc] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setFailed(false);
    setSrc(null);
    setBlob(null);

    async function load() {
      try {
        const nextBlob = await fetchOpencodeAssetBlob(props.path, authMode);
        objectUrl = URL.createObjectURL(nextBlob);
        if (!active) return;
        setBlob(nextBlob);
        setSrc(objectUrl);
      } catch (err) {
        if (active) setFailed(true);
        if (err instanceof Error && err.message === "unauthorized" && active) {
          message.error("请先登录后再下载图片");
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [authMode, message, props.path]);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filenameFromAssetPath(props.path);
        anchor.click();
        URL.revokeObjectURL(url);
        message.success("图片已开始下载");
        return;
      }
      await downloadOpencodeAsset(props.path, authMode);
      message.success("图片已开始下载");
    } catch (err) {
      if (err instanceof Error && err.message === "unauthorized") {
        message.error("请先登录后再下载图片");
      } else {
        message.error("下载失败，请稍后重试");
      }
    } finally {
      setDownloading(false);
    }
  }

  if (failed) {
    return <div className={`${styles.fallback} ${props.className || ""}`}>图片加载失败：{props.path}</div>;
  }

  if (!src) {
    return (
      <div className={`${styles.loading} ${props.className || ""}`}>
        <Spin size="small" />
      </div>
    );
  }

  const caption = props.alt || props.path.split("/").pop() || "image";

  return (
    <figure className={`${styles.figure} ${props.className || ""}`}>
      <div className={styles.imageWrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.image} src={src} alt={caption} loading="lazy" />
        <button
          type="button"
          className={styles.downloadBtn}
          aria-label={`下载 ${caption}`}
          title="下载图片"
          disabled={downloading}
          onClick={() => void handleDownload()}
        >
          <DownloadOutlined />
        </button>
      </div>
    </figure>
  );
}
