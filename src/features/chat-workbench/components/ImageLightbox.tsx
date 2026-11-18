"use client";

import { CloseOutlined, DownloadOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./ImageLightbox.module.css";

export type LightboxImageItem = {
  src: string;
  name: string;
  path?: string;
};

export function ImageLightbox(props: {
  items: LightboxImageItem[];
  activeIndex: number;
  onClose: () => void;
  onChange: (index: number) => void;
  onDownload?: (item: LightboxImageItem) => void;
}) {
  const item = props.items[props.activeIndex];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
      if (event.key === "ArrowLeft" && props.items.length > 1) {
        props.onChange((props.activeIndex - 1 + props.items.length) % props.items.length);
      }
      if (event.key === "ArrowRight" && props.items.length > 1) {
        props.onChange((props.activeIndex + 1) % props.items.length);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [props]);

  if (!item || typeof document === "undefined") return null;

  return createPortal(
    <div className={styles.overlay} onClick={props.onClose}>
      <div className={styles.topBar} onClick={(e) => e.stopPropagation()}>
        <div className={styles.counter}>
          Attached image {props.activeIndex + 1} {props.items.length > 1 ? `/ ${props.items.length}` : ""}
        </div>
        <div className={styles.actions}>
          {props.onDownload ? (
            <button type="button" className={styles.iconBtn} onClick={() => props.onDownload?.(item)} aria-label="下载图片">
              <DownloadOutlined />
            </button>
          ) : null}
          <button type="button" className={styles.iconBtn} onClick={props.onClose} aria-label="关闭预览">
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className={styles.stage} onClick={(e) => e.stopPropagation()}>
        {props.items.length > 1 ? (
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navLeft}`}
            onClick={() => props.onChange((props.activeIndex - 1 + props.items.length) % props.items.length)}
            aria-label="上一张"
          >
            <LeftOutlined />
          </button>
        ) : null}
        <div className={styles.imagePane}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.image} src={item.src} alt={item.name} />
        </div>
        {props.items.length > 1 ? (
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navRight}`}
            onClick={() => props.onChange((props.activeIndex + 1) % props.items.length)}
            aria-label="下一张"
          >
            <RightOutlined />
          </button>
        ) : null}
      </div>
      {props.items.length > 1 ? (
        <div className={styles.thumbRail} onClick={(e) => e.stopPropagation()}>
          {props.items.map((thumb, index) => (
            <button
              key={`${thumb.src}-${index}`}
              type="button"
              className={`${styles.thumbBtn} ${index === props.activeIndex ? styles.thumbBtnActive : ""}`}
              onClick={() => props.onChange(index)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb.src} alt={thumb.name} className={styles.thumbImage} />
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
