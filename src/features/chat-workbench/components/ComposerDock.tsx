"use client";

import { ArrowUpOutlined, DownOutlined, PaperClipOutlined } from "@ant-design/icons";
import { Empty, Select, Spin, Typography } from "antd";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import type { AndroidAppScope, AndroidClassCandidate, ChatAttachment } from "../types";
import { AttachmentList } from "./AttachmentList";
import styles from "./ComposerDock.module.css";

const { Text } = Typography;

const COMPOSER_PLACEHOLDER =
  "描述业务问题或迁移需求，也可输入 @类名 分析源码、调用链、双端差异和相关资源";
const COMPOSER_PLACEHOLDER_BUSY = "分析中，请等待完成或点击停止…";

type Props = {
  inputText: string;
  sending: boolean;
  canceling: boolean;
  canSend: boolean;
  attachments: ChatAttachment[];
  uploadingAttachments: boolean;
  appScopes: AndroidAppScope[];
  appScopeId: string;
  selectedClasses: AndroidClassCandidate[];
  classCandidates: AndroidClassCandidate[];
  classSearching: boolean;
  showClassSearchPanel: boolean;
  onInputTextChange: (v: string) => void;
  onUploadFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onAppScopeChange: (v: string) => void;
  onPickClass: (row: AndroidClassCandidate) => void;
  onRemoveClass: (fqn: string, module: string) => void;
  onSend: () => void;
  onCancelSend: () => void;
};

function buildEditorParts(text: string, selected: AndroidClassCandidate[]) {
  if (!text) return [{ type: "text" as const, value: "" }];
  const unique = new Map<string, AndroidClassCandidate>();
  for (const row of selected) {
    if (!unique.has(row.fqn.toLowerCase())) unique.set(row.fqn.toLowerCase(), row);
  }
  const candidates = [...unique.values()].sort((a, b) => b.fqn.length - a.fqn.length);
  if (!candidates.length) return [{ type: "text" as const, value: text }];
  const parts: Array<{ type: "text"; value: string } | { type: "mention"; value: string }> = [];
  let i = 0;
  let buffer = "";
  const isBoundary = (ch?: string) => !ch || /\s/.test(ch);
  while (i < text.length) {
    let matched: string | null = null;
    for (const row of candidates) {
      const withAt = `@${row.fqn}`;
      const withoutAt = row.fqn;
      if (text.startsWith(withAt, i) && isBoundary(text[i - 1]) && isBoundary(text[i + withAt.length])) {
        matched = row.fqn;
        i += withAt.length;
        break;
      }
      if (text.startsWith(withoutAt, i) && isBoundary(text[i - 1]) && isBoundary(text[i + withoutAt.length])) {
        matched = row.fqn;
        i += withoutAt.length;
        break;
      }
    }
    if (matched) {
      if (buffer) {
        parts.push({ type: "text", value: buffer });
        buffer = "";
      }
      parts.push({ type: "mention", value: matched });
      continue;
    }
    buffer += text[i];
    i += 1;
  }
  if (buffer) parts.push({ type: "text", value: buffer });
  return parts;
}

function readEditorText(root: HTMLElement) {
  root.querySelectorAll("img").forEach((node) => node.remove());
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const mention = el.getAttribute("data-mention-fqn");
      out += mention || el.textContent || "";
    }
  }
  return out;
}

function renderEditor(root: HTMLElement, text: string, selected: AndroidClassCandidate[]) {
  const parts = buildEditorParts(text, selected);
  root.replaceChildren();
  for (const part of parts) {
    if (part.type === "text") {
      root.append(document.createTextNode(part.value));
      continue;
    }
    const chip = document.createElement("span");
    chip.className = styles.mentionChipInline;
    chip.setAttribute("contenteditable", "false");
    chip.setAttribute("data-mention-fqn", part.value);
    chip.textContent = part.value;
    root.append(chip);
  }
}

export function ComposerDock(props: Props) {
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const candidatePanelRef = useRef<HTMLDivElement | null>(null);
  const candidateItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreCaretToEndRef = useRef(false);

  const selectedKey = useMemo(
    () => props.selectedClasses.map((x) => x.fqn.toLowerCase()).sort().join("|"),
    [props.selectedClasses]
  );
  useEffect(() => {
    if (!props.showClassSearchPanel || !props.classCandidates.length) {
      setActiveCandidateIndex(0);
      candidateItemRefs.current = [];
      return;
    }
    candidateItemRefs.current.length = props.classCandidates.length;
    setActiveCandidateIndex((prev) => Math.max(0, Math.min(prev, props.classCandidates.length - 1)));
  }, [props.showClassSearchPanel, props.classCandidates]);

  useEffect(() => {
    if (!props.showClassSearchPanel || !props.classCandidates.length) return;
    const item = candidateItemRefs.current[activeCandidateIndex];
    if (!item) return;
    item.scrollIntoView({ block: "nearest" });
  }, [activeCandidateIndex, props.showClassSearchPanel, props.classCandidates.length]);

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const currentText = readEditorText(root);
    const currentKey = Array.from(root.querySelectorAll<HTMLElement>("[data-mention-fqn]"))
      .map((x) => (x.getAttribute("data-mention-fqn") || "").toLowerCase())
      .sort()
      .join("|");
    if (currentText === props.inputText && currentKey === selectedKey) return;
    renderEditor(root, props.inputText, props.selectedClasses);
    if (restoreCaretToEndRef.current) {
      restoreCaretToEndRef.current = false;
      requestAnimationFrame(() => {
        focusEditorToEnd();
        requestAnimationFrame(() => focusEditorToEnd());
      });
    }
  }, [props.inputText, props.selectedClasses, selectedKey]);

  function commitEditorText() {
    const root = editorRef.current;
    if (!root) return;
    props.onInputTextChange(readEditorText(root));
  }

  function focusEditorToEnd() {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function pickCandidateByIndex(index: number) {
    const row = props.classCandidates[index];
    if (!row) return;
    props.onPickClass(row);
    requestAnimationFrame(() => {
      focusEditorToEnd();
      requestAnimationFrame(() => focusEditorToEnd());
    });
  }

  function onEditorKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (props.showClassSearchPanel && props.classCandidates.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveCandidateIndex((prev) => (prev + 1) % props.classCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveCandidateIndex((prev) => (prev - 1 + props.classCandidates.length) % props.classCandidates.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pickCandidateByIndex(activeCandidateIndex);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (props.sending) return;
      if (props.canSend) props.onSend();
      return;
    }
    if (e.key !== "Backspace") return;
    const root = editorRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    let prevNode: Node | null = null;
    if (range.startContainer === root) {
      prevNode = root.childNodes[range.startOffset - 1] || null;
    } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const t = range.startContainer as Text;
      if (range.startOffset > 0) return;
      prevNode = t.previousSibling || t.parentElement?.previousSibling || null;
    } else {
      const el = range.startContainer as Element;
      prevNode = el.childNodes[range.startOffset - 1] || el.previousSibling || null;
    }
    if (prevNode?.nodeType === Node.TEXT_NODE && !((prevNode.textContent || "").trim())) {
      prevNode = prevNode.previousSibling;
    }
    if (!(prevNode instanceof HTMLElement)) return;
    const fqn = prevNode.getAttribute("data-mention-fqn");
    if (!fqn) return;
    e.preventDefault();
    const matched = props.selectedClasses.find((x) => x.fqn.toLowerCase() === fqn.toLowerCase());
    restoreCaretToEndRef.current = true;
    props.onRemoveClass(matched?.fqn || fqn, matched?.module || "");
  }

  function onEditorClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-mention-fqn]");
    if (!chip) return;
    const fqn = chip.getAttribute("data-mention-fqn");
    if (!fqn) return;
    const matched = props.selectedClasses.find((x) => x.fqn.toLowerCase() === fqn.toLowerCase());
    restoreCaretToEndRef.current = true;
    props.onRemoveClass(matched?.fqn || fqn, matched?.module || "");
  }

  function handlePickedFiles(filesInput: FileList | File[] | null) {
    if (props.sending || props.uploadingAttachments) return;
    const files = Array.isArray(filesInput) ? filesInput : Array.from(filesInput || []);
    if (!files.length) return;
    props.onUploadFiles(files);
  }

  function onEditorPaste(e: ReactClipboardEvent<HTMLDivElement>) {
    const clipboardItems = Array.from(e.clipboardData?.items || []);
    const clipboardFiles = clipboardItems
      .filter((item) => item.kind === "file" || item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (clipboardFiles.length) {
      e.preventDefault();
      handlePickedFiles(clipboardFiles);
      return;
    }
    const html = e.clipboardData?.getData("text/html") || "";
    if (/<img[\s>]/i.test(html)) {
      e.preventDefault();
    }
  }

  return (
    <div className={styles.dock}>
      <div className={styles.composerCard}>
        <div className={styles.inputWrap}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.hiddenFileInput}
            onChange={(e) => {
              handlePickedFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          {props.showClassSearchPanel ? (
            <div className={styles.slashPanel} ref={candidatePanelRef}>
              {props.classSearching ? (
                <div className={styles.slashLoading}>
                  <Spin size="small" />
                  <Text type="secondary">正在检索类...</Text>
                </div>
              ) : props.classCandidates.length ? (
                props.classCandidates.map((row, idx) => (
                  <button
                    key={`${row.fqn}::${row.filePath}`}
                    type="button"
                    ref={(el) => {
                      candidateItemRefs.current[idx] = el;
                    }}
                    className={`${styles.slashItem} ${idx === activeCandidateIndex ? styles.slashItemActive : ""}`}
                    onMouseEnter={() => setActiveCandidateIndex(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCandidateByIndex(idx)}
                  >
                    <div className={styles.slashTitle}>
                      {row.platform === "harmony" ? `[鸿蒙] ${row.className}` : row.fqn}
                    </div>
                    <div className={styles.slashMeta}>
                      {row.platform === "harmony" ? row.fqn : row.module}
                    </div>
                  </button>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配结果" />
              )}
            </div>
          ) : null}
          {props.attachments.length ? (
            <div className={styles.attachmentWrap}>
              <AttachmentList attachments={props.attachments} removable onRemove={props.onRemoveAttachment} compact variant="composer-mixed" />
            </div>
          ) : null}
          <div
            ref={editorRef}
            className={`${styles.composerEditor} ${dragActive ? styles.composerEditorDrag : ""}`}
            contentEditable
            suppressContentEditableWarning
            data-placeholder={props.sending ? COMPOSER_PLACEHOLDER_BUSY : COMPOSER_PLACEHOLDER}
            aria-busy={props.sending}
            onInput={commitEditorText}
            onKeyDown={onEditorKeyDown}
            onPaste={onEditorPaste}
            onClick={onEditorClick}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              handlePickedFiles(e.dataTransfer.files);
            }}
          />
        </div>
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <Select
              className={styles.scopePill}
              classNames={{ popup: { root: styles.scopePillPopup } }}
              value={props.appScopeId}
              onChange={props.onAppScopeChange}
              suffixIcon={<DownOutlined />}
              options={props.appScopes.map((x) => ({ value: x.id, label: x.label }))}
              popupMatchSelectWidth={180}
            />
          </div>
          <div className={styles.toolbarRight}>
            {props.uploadingAttachments || props.sending ? <Spin size="small" className={styles.toolbarSpinner} /> : null}
            {!props.sending ? (
              <button
                type="button"
                className={styles.attachBtn}
                aria-label="上传附件"
                title="上传附件"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperClipOutlined />
              </button>
            ) : null}
            {props.sending ? (
              <button
                type="button"
                className={styles.stopSquareBtn}
                disabled={props.canceling}
                aria-label={props.canceling ? "终止中" : "停止"}
                title={props.canceling ? "终止中" : "停止"}
                onClick={props.onCancelSend}
              >
                <span className={styles.stopIcon} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.sendCircleBtn}
                disabled={!props.canSend}
                aria-label="发送"
                title="发送"
                onClick={props.onSend}
              >
                <ArrowUpOutlined />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
