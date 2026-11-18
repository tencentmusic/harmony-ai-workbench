"use client";

import { CopyOutlined, DownloadOutlined, ExportOutlined, LoadingOutlined, MenuUnfoldOutlined, ReloadOutlined, SettingOutlined, WarningOutlined } from "@ant-design/icons";
import { App, Button, Space, Spin, Typography } from "antd";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { KugouHarmonyAiIcon } from "../../admin-console/components/KugouHarmonyAiIcon";
import { normalizeChatAttachments } from "@/lib/chat-attachments-shared";
import { MarkdownMessage } from "./MarkdownMessage";
import { MarqueeTitle } from "./MarqueeTitle";
import { AttachmentList } from "./AttachmentList";
import { OpencodeImageAttachments } from "./OpencodeImageAttachments";
import type { ChatMessage, OpencodeImageAttachment } from "../types";
import { collectOpencodeImages, stripOpencodeAssetContentFromMarkdown } from "@/lib/opencode/opencode-image";
import { downloadOpencodeAssetsZip } from "@/lib/opencode/opencode-asset-download";
import styles from "./ConversationPane.module.css";

const { Title, Paragraph, Text, Link } = Typography;
const ASSISTANT_COLLAPSE_HEIGHT = 360;

function stripEvidenceSection(content: string) {
  const text = String(content || "");
  if (!text) return text;
  return text
    .replace(/\n{0,2}#{1,6}\s*证据来源[\s\S]*$/i, "")
    .replace(/\n{0,2}证据来源\s*\n[\s\S]*$/i, "")
    .trimEnd();
}

type Props = {
  activeSessionId: string;
  title: string;
  messages: ChatMessage[];
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  loadingMessages: boolean;
  sending: boolean;
  forceStickBottomTick: number;
  streamingReply: string;
  streamingImages: OpencodeImageAttachment[];
  streamingStatus: "idle" | "pending" | "running";
  showExpandPanelButton?: boolean;
  onLoadOlderMessages: () => Promise<boolean>;
  onExpandPanel?: () => void;
  onAdmin: () => void;
  onCopy: (text: string) => void;
  onExport: (text: string) => void;
  onQuickPrompt: (text: string) => void;
};

function AssistantMessageContent({
  content,
  images = [],
  isLatestAssistant,
}: {
  content: string;
  images?: OpencodeImageAttachment[];
  isLatestAssistant: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(isLatestAssistant);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    setExpanded(isLatestAssistant);
  }, [isLatestAssistant]);

  const displayContent = useMemo(
    () => (images.length ? stripOpencodeAssetContentFromMarkdown(content) : content),
    [content, images.length]
  );

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => {
      setOverflow(el.scrollHeight > ASSISTANT_COLLAPSE_HEIGHT + 4);
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayContent, images, expanded]);

  const collapsed = overflow && !expanded;

  return (
    <>
      <div ref={bodyRef} className={collapsed ? styles.assistantBodyCollapsed : undefined}>
        <OpencodeImageAttachments images={images} />
        {displayContent ? <MarkdownMessage content={displayContent} /> : null}
      </div>
      {overflow ? (
        <Link className={styles.expandLink} onClick={() => setExpanded((x) => !x)}>
          {expanded ? "收起" : "展开全部"}
        </Link>
      ) : null}
    </>
  );
}

export function ConversationPane(props: Props) {
  const { message } = App.useApp();
  const quickPrompts = [
    "查询指定功能的业务流程和双端实现",
    "分析 @类名 的调用链和影响范围",
    "根据 Android 实现生成鸿蒙迁移代码",
    "查找设计切图或 drawable 原图",
  ];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickBottomRef = useRef(true);
  const lastSessionRef = useRef("");
  const loadingOlderRef = useRef(false);
  const suppressLoadOlderUntilRef = useRef(0);
  const sendingRef = useRef(props.sending);
  const pinVersionRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const latestAssistantId = useMemo(
    () => [...props.messages].reverse().find((m) => m.role === "assistant")?.id || "",
    [props.messages]
  );
  const streamingImages = useMemo(
    () =>
      collectOpencodeImages({
        extra: props.streamingImages,
        content: stripEvidenceSection(props.streamingReply),
      }),
    [props.streamingImages, props.streamingReply]
  );
  const streamingDisplayContent = useMemo(() => {
    const text = stripEvidenceSection(props.streamingReply || "…");
    return streamingImages.length ? stripOpencodeAssetContentFromMarkdown(text) : text;
  }, [props.streamingReply, streamingImages.length]);
  const showStreamingStatus = props.sending && (props.streamingStatus !== "running" || !props.streamingReply.trim());
  const streamingStatusText = props.streamingStatus === "running" ? "生成中…" : "思考中…";

  async function handleDownloadAllImages(images: OpencodeImageAttachment[]) {
    if (!images.length) return;
    try {
      await downloadOpencodeAssetsZip(images.map((item) => ({ path: item.path })));
      message.success(`已开始下载 ${images.length} 张图片`);
    } catch (err) {
      if (err instanceof Error && err.message === "unauthorized") {
        message.error("请先登录后再下载图片");
      } else {
        message.error("下载失败，请稍后重试");
      }
    }
  }

  function renderAssistantActions(content: string, images: OpencodeImageAttachment[], interrupted = false) {
    return (
      <Space className={styles.actionRow} size={14}>
        <Link className={styles.actionLink} onClick={() => props.onCopy(content)}>
          <CopyOutlined />
          复制
        </Link>
        <Link className={styles.actionLink} onClick={() => props.onExport(content)}>
          <ExportOutlined />
          导出
        </Link>
        {images.length ? (
          <Link className={styles.actionLink} onClick={() => void handleDownloadAllImages(images)}>
            <DownloadOutlined />
            下载全部图片
          </Link>
        ) : null}
        {interrupted ? (
          <Link className={styles.actionLink} onClick={() => props.onQuickPrompt("请继续完成上一条回答，不要重复已经完成的分析。") }>
            <ReloadOutlined />
            继续生成
          </Link>
        ) : null}
      </Space>
    );
  }

  function clearScheduledScroll() {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (scrollTimerRef.current != null) {
      window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
  }

  function stickToBottom(immediate = false) {
    const run = () => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      messageEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    };
    if (immediate) {
      run();
      return;
    }
    clearScheduledScroll();
    scrollRafRef.current = requestAnimationFrame(() => {
      run();
      scrollTimerRef.current = window.setTimeout(run, 24);
    });
  }

  useEffect(() => {
    sendingRef.current = props.sending;
  }, [props.sending]);

  useEffect(() => () => clearScheduledScroll(), []);

  useEffect(() => {
    if (lastSessionRef.current !== props.activeSessionId) {
      lastSessionRef.current = props.activeSessionId;
      shouldStickBottomRef.current = true;
      pinVersionRef.current += 1;
      suppressLoadOlderUntilRef.current = Date.now() + 1200;
      stickToBottom(true);
    }
  }, [props.activeSessionId]);

  useLayoutEffect(() => {
    if (props.sending || shouldStickBottomRef.current) {
      stickToBottom();
    }
  }, [props.messages.length, props.streamingReply, streamingImages.length, props.sending]);

  useLayoutEffect(() => {
    shouldStickBottomRef.current = true;
    pinVersionRef.current += 1;
    suppressLoadOlderUntilRef.current = Date.now() + 1500;
    stickToBottom(true);
  }, [props.forceStickBottomTick]);

  async function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickBottomRef.current = distance <= 120;
    if (!props.sending && Date.now() >= suppressLoadOlderUntilRef.current && el.scrollTop <= 120 && props.hasMoreMessages && !props.loadingMoreMessages && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      const pinVersion = pinVersionRef.current;
      const prevHeight = el.scrollHeight;
      const prevTop = el.scrollTop;
      const loaded = await props.onLoadOlderMessages();
      if (loaded) {
        requestAnimationFrame(() => {
          const target = scrollRef.current;
          if (!target) return;
          if (pinVersionRef.current !== pinVersion) return;
          if (sendingRef.current || shouldStickBottomRef.current) return;
          const delta = target.scrollHeight - prevHeight;
          target.scrollTop = prevTop + delta;
        });
      }
      loadingOlderRef.current = false;
    }
  }

  return (
    <div className={styles.main}>
      <div className={styles.top}>
        <div className={styles.titleWrap}>
          {props.showExpandPanelButton ? (
            <Button type="text" className={styles.expandPanelBtn} icon={<MenuUnfoldOutlined />} onClick={props.onExpandPanel} aria-label="展开会话面板" />
          ) : null}
          <KugouHarmonyAiIcon size={22} />
          <MarqueeTitle className={styles.title} text={`Harmony AI Workbench · ${props.title}`} />
        </div>
        <Button type="text" icon={<SettingOutlined />} className={styles.adminBtn} onClick={props.onAdmin}>
          管理后台
        </Button>
      </div>
      <div className={styles.scroll} ref={scrollRef} onScroll={handleScroll}>
        {props.loadingMoreMessages ? (
          <div className={styles.loadingOlder}>
            <Spin size="small" />
          </div>
        ) : null}
        {props.loadingMessages ? (
          <div className={styles.empty}>
            <Spin />
          </div>
        ) : props.messages.length ? (
          props.messages.map((m) => {
            const assistantContent = m.role === "assistant" ? stripEvidenceSection(m.content) : m.content;
            const assistantImages =
              m.role === "assistant" ? collectOpencodeImages({ metadata: m.metadata, content: assistantContent }) : [];
            const userAttachments = m.role === "user" ? normalizeChatAttachments(m.metadata?.attachments) : [];
            const interrupted = m.role === "assistant" && m.metadata?.interrupted === true;
            const userImageAttachments = userAttachments.filter((item) => item.kind === "image");
            const userFileAttachments = userAttachments.filter((item) => item.kind !== "image");
            return (
              <div key={m.id} className={styles.row}>
                <div className={`${styles.rowInner} ${m.role === "user" ? styles.user : styles.assistant}`}>
                  <div className={styles.content}>
                    <div className={styles.meta}>{new Date(m.createdAt).toLocaleString()}</div>
                    <div className={`${styles.card} ${m.role === "assistant" ? styles.cardAssistant : styles.cardUser}`}>
                      {m.role === "assistant" ? (
                        <>
                          {interrupted ? (
                            <div className={styles.interruptedNotice}>
                              <WarningOutlined />
                              回答生成中断，以下内容可能不完整
                            </div>
                          ) : null}
                          <AssistantMessageContent content={assistantContent} images={assistantImages} isLatestAssistant={m.id === latestAssistantId} />
                        </>
                      ) : (
                        <>
                          {userImageAttachments.length ? (
                            <AttachmentList attachments={userImageAttachments} compact variant="composer" />
                          ) : null}
                          {userFileAttachments.length ? (
                            <AttachmentList attachments={userFileAttachments} compact variant="default" />
                          ) : null}
                          {m.content ? <div className={styles.text}>{m.content}</div> : null}
                        </>
                      )}
                    </div>
                    {m.role === "assistant" ? renderAssistantActions(assistantContent, assistantImages, interrupted) : null}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className={styles.empty}>
            <Text className={styles.emptyKicker}>KUGOU HARMONY AI WORKBENCH</Text>
            <Title level={2} style={{ margin: "6px 0 8px" }}>
              你好，今天想让 Harmony AI Workbench 帮你做什么？
            </Title>
            <Paragraph type="secondary">查询业务知识与双端源码，分析调用链和端间差异，生成鸿蒙迁移代码，并检索设计切图与 drawable 资源。</Paragraph>
            <div className={styles.emptyActions}>
              {quickPrompts.map((x) => (
                <Button key={x} className={styles.emptyActionBtn} onClick={() => props.onQuickPrompt(x)}>
                  {x}
                </Button>
              ))}
            </div>
          </div>
        )}
        {props.sending ? (
          <div className={styles.row}>
            <div className={`${styles.rowInner} ${styles.assistant}`}>
              <div className={styles.content}>
                {showStreamingStatus ? (
                  <Space align="center" style={{ marginBottom: 10 }}>
                    <LoadingOutlined spin />
                    <Text type="secondary">{streamingStatusText}</Text>
                  </Space>
                ) : null}
                <div className={`${styles.card} ${styles.cardAssistant}`}>
                  <OpencodeImageAttachments images={streamingImages} />
                  <MarkdownMessage content={streamingDisplayContent} loading />
                </div>
                {streamingImages.length ? renderAssistantActions(props.streamingReply || "", streamingImages) : null}
              </div>
            </div>
          </div>
        ) : null}
        <div ref={messageEndRef} />
      </div>
    </div>
  );
}

