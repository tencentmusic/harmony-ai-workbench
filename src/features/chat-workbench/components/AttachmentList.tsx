"use client";

import { CloseOutlined, FileImageOutlined, FileOutlined, FilePdfOutlined } from "@ant-design/icons";
import { App, Spin } from "antd";
import { useEffect, useState } from "react";
import type { ChatAttachment } from "../types";
import {
  downloadOpencodeAsset,
  fetchOpencodeAssetBlob,
  type AssetAuthMode,
} from "@/lib/opencode/opencode-asset-download";
import { ImageLightbox, type LightboxImageItem } from "./ImageLightbox";
import styles from "./AttachmentList.module.css";

function FileTypeIcon({ mime, kind }: { mime: string; kind: ChatAttachment["kind"] }) {
  if (kind === "image") return <FileImageOutlined />;
  if (mime === "application/pdf") return <FilePdfOutlined />;
  return <FileOutlined />;
}

function AttachmentTile(props: {
  attachment: ChatAttachment;
  removable?: boolean;
  onRemove?: (path: string) => void;
  compact?: boolean;
  variant?: "default" | "composer" | "composer-file" | "composer-mixed";
  authMode?: AssetAuthMode;
  onPreviewReady?: (path: string, src: string) => void;
  onPreview?: (path: string) => void;
}) {
  const { message } = App.useApp();
  const { attachment } = props;
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  const [displaySrc, setDisplaySrc] = useState("");
  const localPreviewSrc = attachment.dataUrl || attachment.previewUrl || remotePreviewUrl;

  useEffect(() => {
    setDisplaySrc(localPreviewSrc || "");
    setPreviewFailed(false);
  }, [localPreviewSrc]);

  useEffect(() => {
    const readySrc = attachment.dataUrl || attachment.previewUrl;
    if (readySrc && attachment.kind === "image") {
      props.onPreviewReady?.(attachment.path, readySrc);
    }
  }, [attachment.dataUrl, attachment.kind, attachment.path, attachment.previewUrl, props.onPreviewReady]);

  useEffect(() => {
    if (attachment.dataUrl || attachment.previewUrl || attachment.kind !== "image" || !attachment.path) return;
    let active = true;
    let nextObjectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchOpencodeAssetBlob(attachment.path, props.authMode);
        nextObjectUrl = URL.createObjectURL(blob);
        if (!active) return;
        setRemotePreviewUrl(nextObjectUrl);
        props.onPreviewReady?.(attachment.path, nextObjectUrl);
      } catch {
        if (active) setPreviewFailed(true);
      }
    })();
    return () => {
      active = false;
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [attachment.dataUrl, attachment.kind, attachment.path, attachment.previewUrl, props.authMode]);

  async function recoverPreviewFromServer() {
    if (!attachment.path || attachment.kind !== "image") return;
    try {
      const blob = await fetchOpencodeAssetBlob(attachment.path, props.authMode);
      const nextObjectUrl = URL.createObjectURL(blob);
      setRemotePreviewUrl((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
        return nextObjectUrl;
      });
      setDisplaySrc(nextObjectUrl);
      setPreviewFailed(false);
      props.onPreviewReady?.(attachment.path, nextObjectUrl);
    } catch {
      setPreviewFailed(true);
    }
  }

  async function handleDownload() {
    if (!attachment.path || props.removable || downloading) return;
    setDownloading(true);
    try {
      await downloadOpencodeAsset(attachment.path, props.authMode);
    } catch {
      message.error("附件下载失败，请稍后重试");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className={`${styles.tile} ${props.compact ? styles.tileCompact : ""} ${props.variant === "composer" || (props.variant === "composer-mixed" && attachment.kind === "image") ? styles.tileComposer : ""} ${props.variant === "composer-mixed" && attachment.kind === "image" ? styles.tileComposerMixed : ""} ${props.variant === "composer-file" || (props.variant === "composer-mixed" && attachment.kind !== "image") ? styles.tileComposerFile : ""} ${!props.removable && attachment.path ? styles.tileInteractive : ""}`}
      style={
        (props.variant === "composer" || props.variant === "composer-mixed") && attachment.kind === "image" && imageRatio
          ? { width: `${Math.round(Math.max(52, Math.min(132, 54 * imageRatio)))}px` }
          : undefined
      }
      onClick={() => {
        if (attachment.kind === "image") {
          props.onPreview?.(attachment.path);
          return;
        }
        void handleDownload();
      }}
      role="button"
      tabIndex={0}
    >
      <div className={styles.thumb}>
        {attachment.kind === "image" ? (
          displaySrc && !previewFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displaySrc}
              alt={attachment.name}
              className={styles.thumbImage}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setImageRatio(img.naturalWidth / img.naturalHeight);
                }
              }}
              onError={() => {
                if (attachment.dataUrl && displaySrc !== attachment.dataUrl) {
                  setDisplaySrc(attachment.dataUrl);
                  setPreviewFailed(false);
                  props.onPreviewReady?.(attachment.path, attachment.dataUrl);
                  return;
                }
                if (!remotePreviewUrl && attachment.path && !props.removable) {
                  void recoverPreviewFromServer();
                  return;
                }
                setPreviewFailed(true);
              }}
            />
          ) : (
            <div className={styles.thumbFallback}>
              {!previewFailed && attachment.path && !props.removable ? <Spin size="small" /> : <FileImageOutlined />}
            </div>
          )
        ) : (
          <div className={styles.thumbFallback}>
            <FileTypeIcon mime={attachment.mime} kind={attachment.kind} />
          </div>
        )}
      </div>
      {props.variant !== "composer" ? (
        <div className={styles.meta}>
          <div className={styles.name}>{attachment.name}</div>
        </div>
      ) : null}
      {props.removable ? (
        <button
          type="button"
          className={`${styles.removeBtn} ${(props.variant === "composer" || (props.variant === "composer-mixed" && attachment.kind === "image")) ? styles.removeBtnComposer : ""}`}
          aria-label={`移除 ${attachment.name}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.(attachment.path);
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
    </div>
  );
}

export function AttachmentList(props: {
  attachments: ChatAttachment[];
  removable?: boolean;
  onRemove?: (path: string) => void;
  compact?: boolean;
  variant?: "default" | "composer" | "composer-file" | "composer-mixed";
  authMode?: AssetAuthMode;
}) {
  const [previewSrcMap, setPreviewSrcMap] = useState<Record<string, string>>({});
  const [activePreviewPath, setActivePreviewPath] = useState("");

  const imageItems: LightboxImageItem[] = props.attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      src: previewSrcMap[attachment.path] || attachment.dataUrl || attachment.previewUrl || "",
      name: attachment.name,
      path: attachment.path,
    }))
    .filter((item) => !!item.src);

  const activePreviewIndex = imageItems.findIndex((item) => item.path === activePreviewPath);

  if (!props.attachments.length) return null;
  return (
    <>
      <div
        className={`${styles.list} ${props.compact ? styles.listCompact : ""} ${props.variant === "composer" ? styles.listComposer : ""} ${props.variant === "composer-file" ? styles.listComposerFile : ""} ${props.variant === "composer-mixed" ? styles.listComposerMixed : ""}`}
      >
        {props.attachments.map((attachment) => (
          <AttachmentTile
            key={attachment.path}
            attachment={attachment}
            removable={props.removable}
            onRemove={props.onRemove}
            compact={props.compact}
            variant={props.variant}
            authMode={props.authMode}
            onPreviewReady={(path, src) =>
              setPreviewSrcMap((prev) => (prev[path] === src ? prev : { ...prev, [path]: src }))
            }
            onPreview={(path) => setActivePreviewPath(path)}
          />
        ))}
      </div>
      {activePreviewIndex >= 0 ? (
        <ImageLightbox
          items={imageItems}
          activeIndex={activePreviewIndex}
          onClose={() => setActivePreviewPath("")}
          onChange={(index) => setActivePreviewPath(imageItems[index]?.path || "")}
          onDownload={(item) => {
            if (item.path) void downloadOpencodeAsset(item.path, props.authMode);
          }}
        />
      ) : null}
    </>
  );
}
