"use client";

import { isValidElement, type ReactNode } from "react";
import { App, Button } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveOpencodeAssetPathFromMarkdownSrc } from "@/lib/opencode/opencode-image";
import { OpencodeAssetImage } from "./OpencodeAssetImage";
import styles from "./MarkdownMessage.module.css";

function toText(value: ReactNode): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => toText(item)).join("");
  if (isValidElement(value)) return toText((value.props as { children?: ReactNode }).children ?? "");
  return "";
}

export function MarkdownMessage({
  content,
  loading,
  themeMode = "light",
  authMode = "user",
}: {
  content: string;
  loading?: boolean;
  themeMode?: "light" | "dark";
  authMode?: "user" | "admin";
}) {
  const { message } = App.useApp();

  async function copyCode(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success("代码已复制");
    } catch {
      message.error("复制失败");
    }
  }

  return (
    <div className={`${styles.root} ${themeMode === "dark" ? styles.dark : ""} ${loading ? styles.loading : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const assetPath = resolveOpencodeAssetPathFromMarkdownSrc(typeof src === "string" ? src : undefined);
            if (assetPath) {
              return <OpencodeAssetImage path={assetPath} alt={alt} authMode={authMode} />;
            }
            if (!src) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt || ""} className={styles.inlineImage} loading="lazy" />
            );
          },
          pre: ({ children }) => {
            const first = Array.isArray(children) ? children[0] : children;
            if (!isValidElement(first)) return <pre>{children}</pre>;
            const codeProps = first.props as { className?: string; children?: ReactNode };
            const className = codeProps.className || "";
            const lang = (className.match(/language-([\w-]+)/)?.[1] || "").toLowerCase();
            const code = toText(codeProps.children).replace(/\n$/, "");
            return (
              <pre className={styles.codeBlock}>
                <div className={styles.codeHeader}>
                  <span className={styles.codeLang}>{lang || "text"}</span>
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copyCode(code)}>
                    复制
                  </Button>
                </div>
                <code className={`${styles.codeBody} ${className}`}>{code}</code>
              </pre>
            );
          },
          code: ({ className, children }) => {
            if (className) return <code className={className}>{children}</code>;
            return <code className={styles.inlineCode}>{children}</code>;
          },
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content || ""}
      </ReactMarkdown>
    </div>
  );
}
