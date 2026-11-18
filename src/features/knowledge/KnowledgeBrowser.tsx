"use client";

import {
  BookOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Popover, Spin, Tag, Tree, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  KnowledgeDocument,
  KnowledgeLocator,
  KnowledgeLibrarySummary,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
} from "@/contracts/knowledge";
import styles from "./KnowledgeBrowser.module.css";

const { Text, Title } = Typography;

type AskContext = Pick<KnowledgeDocument, "sourceLabel" | "path" | "title"> & {
  locator: KnowledgeLocator;
  selectedText?: string;
};

type SelectionAsk = {
  text: string;
  x: number;
  y: number;
};

type Props = {
  appScopeId?: string;
  onAppScopeChange?: (appScopeId: string) => void;
  onAskAi?: (context: AskContext) => void;
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("hm_token") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store", signal });
  if (!response.ok) throw new Error(`knowledge_http_${response.status}`);
  return response.json() as Promise<T>;
}

async function track(event: "page_view" | "search" | "ask_ai", docPath: string, payload?: Record<string, unknown>) {
  try {
    await fetch("/api/doc-analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ events: [{ event, docPath, payload }] }),
      keepalive: true,
    });
  } catch {
    // 埋点失败不影响阅读。
  }
}

function firstDocumentPath(nodes: KnowledgeTreeNode[]): string {
  for (const node of nodes) {
    if (node.path) return node.path;
    const nested = firstDocumentPath(node.children || []);
    if (nested) return nested;
  }
  return "";
}

type TreeLocation = { key: Key; parentKeys: Key[] };

function findTreeLocation(nodes: KnowledgeTreeNode[], documentPath: string, parentKeys: Key[] = []): TreeLocation | null {
  for (const node of nodes) {
    if (node.path === documentPath) return { key: node.key, parentKeys };
    const nested = findTreeLocation(node.children || [], documentPath, [...parentKeys, node.key]);
    if (nested) return nested;
  }
  return null;
}

function highlightText(value: string, query: string) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return value;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(${escaped.join("|")})`, "gi");
  return value.split(matcher).map((part, index) => (
    terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase())
      ? <mark key={`${part}-${index}`} className={styles.searchHighlight}>{part}</mark>
      : part
  ));
}

function resolveLinkedPath(documentPath: string, href: string) {
  const withoutHash = href.split("#")[0].split("?")[0];
  if (!withoutHash) return "";
  const decoded = decodeURIComponent(withoutHash).replace(/\\/g, "/");
  if (withoutHash.startsWith("/")) return normalizeBrowserPath(decoded);
  const slash = documentPath.lastIndexOf("/");
  const directory = slash >= 0 ? documentPath.slice(0, slash) : "";
  return normalizeBrowserPath(`${directory}/${decoded}`);
}

function normalizeBrowserPath(value: string) {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function fileExtension(value: string) {
  const name = value.slice(value.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function isExternal(href: string) {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

function roleLabel(role: string) {
  if (role === "canonical") return "技术知识";
  if (role === "evidence") return "迁移案例";
  if (role === "codegraph") return "代码图谱";
  return "参考资料";
}

function KnowledgeImage(props: {
  libraryId: string;
  documentPath: string;
  src: string;
  alt: string;
}) {
  const [objectUrl, setObjectUrl] = useState("");
  useEffect(() => {
    if (!props.src || isExternal(props.src)) {
      setObjectUrl(props.src);
      return;
    }
    const controller = new AbortController();
    const assetPath = resolveLinkedPath(props.documentPath, props.src);
    const query = new URLSearchParams({
      libraryId: props.libraryId,
      path: assetPath,
    });
    let created = "";
    void fetch(`/api/knowledge/asset?${query}`, { headers: authHeaders(), signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("asset_failed");
        return response.blob();
      })
      .then((blob) => {
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => setObjectUrl(""));
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [props.documentPath, props.libraryId, props.src]);
  if (!objectUrl) return <span className={styles.imageFallback}>{props.alt || "图片加载失败"}</span>;
  return <img className={styles.documentImage} src={objectUrl} alt={props.alt} loading="lazy" />;
}

export function KnowledgeBrowser(props: Props) {
  const [libraries, setLibraries] = useState<KnowledgeLibrarySummary[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState("");
  const [tree, setTree] = useState<KnowledgeTreeNode[]>([]);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [selectionAsk, setSelectionAsk] = useState<SelectionAsk | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const documentRef = useRef<KnowledgeDocument | null>(null);
  const searchAnchorRef = useRef<HTMLDivElement | null>(null);
  const searchPopupRef = useRef<HTMLDivElement | null>(null);
  const directoryBodyRef = useRef<HTMLDivElement | null>(null);
  const markdownRef = useRef<HTMLElement | null>(null);
  const searchRequestRef = useRef(0);

  const technicalLibraries = useMemo(() => libraries.filter((item) => item.group === "technical"), [libraries]);
  const migrationLibraries = useMemo(() => libraries.filter((item) => item.group === "migration"), [libraries]);
  const selectedLibrary = useMemo(
    () => libraries.find((item) => item.libraryId === selectedLibraryId),
    [libraries, selectedLibraryId],
  );
  const treeLocation = useMemo(
    () => document?.path ? findTreeLocation(tree, document.path) : null,
    [document?.path, tree],
  );

  useEffect(() => {
    if (!treeLocation) return;
    setExpandedKeys((keys) => {
      const merged = [...new Set([...keys, ...treeLocation.parentKeys])];
      return merged.length === keys.length ? keys : merged;
    });
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        directoryBodyRef.current
          ?.querySelector(".ant-tree-node-selected")
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [treeLocation]);

  useEffect(() => {
    if (!searchOpen) return;
    function closeSearch(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchAnchorRef.current?.contains(target) || searchPopupRef.current?.contains(target)) return;
      setSearchOpen(false);
    }
    window.document.addEventListener("mousedown", closeSearch);
    return () => window.document.removeEventListener("mousedown", closeSearch);
  }, [searchOpen]);

  useEffect(() => {
    function handleSelection(event: MouseEvent) {
      if ((event.target as Element | null)?.closest?.("[data-knowledge-selection-ui]")) return;
      window.requestAnimationFrame(() => {
        const container = markdownRef.current;
        const selection = window.getSelection();
        if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
          setSelectionAsk(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          setSelectionAsk(null);
          return;
        }
        const text = selection.toString().replace(/\s+/g, " ").trim();
        if (text.length < 2) {
          setSelectionAsk(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const x = Math.max(72, Math.min(rect.left - containerRect.left + rect.width / 2, containerRect.width - 72));
        setSelectionAsk({
          text: text.slice(0, 3000),
          x,
          y: rect.bottom - containerRect.top + 8,
        });
      });
    }
    window.document.addEventListener("mouseup", handleSelection);
    return () => window.document.removeEventListener("mouseup", handleSelection);
  }, []);

  useEffect(() => setSelectionAsk(null), [document?.path]);

  useEffect(() => {
    const queryText = searchText.trim();
    const requestId = ++searchRequestRef.current;
    if (!queryText || !selectedLibraryId) {
      setSearching(false);
      setSearchHits([]);
      setSearchOpen(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    setSearchHits([]);
    setSearchOpen(true);
    setError("");
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ libraryId: selectedLibraryId, q: queryText });
      void getJson<{ items: KnowledgeSearchHit[] }>(`/api/knowledge/search?${query}`, controller.signal)
        .then((result) => {
          if (searchRequestRef.current !== requestId) return;
          setSearchHits(result.items);
          void track("search", `/knowledge/${selectedLibraryId}`, { keyword: queryText });
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted || searchRequestRef.current !== requestId) return;
          setSearchOpen(false);
          setError(reason instanceof Error ? reason.message : "knowledge_search_failed");
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) setSearching(false);
        });
    }, 280);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchText, selectedLibraryId]);

  useEffect(() => {
    let active = true;
    void getJson<{ items: KnowledgeLibrarySummary[] }>("/api/knowledge/catalog")
      .then(({ items }) => {
        if (!active) return;
        setLibraries(items);
        setSelectedLibraryId(items.find((item) => item.group === "technical")?.libraryId || items[0]?.libraryId || "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "knowledge_catalog_failed"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const openDocument = useCallback(async (documentPath: string, libraryId = selectedLibraryId) => {
    if (!libraryId || !documentPath) return;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ libraryId, path: documentPath });
      const result = await getJson<KnowledgeDocument>(`/api/knowledge/doc?${query}`);
      setSelectedLibraryId(libraryId);
      documentRef.current = result;
      setDocument(result);
      setSearchHits([]);
      setSearchText("");
      setSearchOpen(false);
      void track("page_view", `/knowledge/${libraryId}/${documentPath}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "knowledge_document_failed");
    } finally {
      setLoading(false);
    }
  }, [selectedLibraryId]);

  useEffect(() => {
    if (!selectedLibraryId) return;
    let active = true;
    setLoading(true);
    const query = new URLSearchParams({ libraryId: selectedLibraryId });
    void getJson<{ items: KnowledgeTreeNode[] }>(`/api/knowledge/tree?${query}`)
      .then(({ items }) => {
        if (!active) return;
        setTree(items);
        setSearchHits([]);
        const currentDocument = documentRef.current;
        if (currentDocument?.libraryId !== selectedLibraryId) {
          documentRef.current = null;
          setDocument(null);
          const initialPath = firstDocumentPath(items);
          if (initialPath) void openDocument(initialPath, selectedLibraryId);
        }
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "knowledge_tree_failed"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [openDocument, selectedLibraryId]);

  function changeLibrary(library: KnowledgeLibrarySummary) {
    setSelectedLibraryId(library.libraryId);
    setTree([]);
    setSearchHits([]);
    setSearchText("");
    setSearchOpen(false);
    setExpandedKeys([]);
    documentRef.current = null;
    setDocument(null);
    if (library.appScopeId) props.onAppScopeChange?.(library.appScopeId);
  }

  function askAi(selectedText?: string) {
    if (!document) return;
    void track("ask_ai", `/knowledge/${document.libraryId}/${document.path}`, {
      selectionLength: selectedText?.length || 0,
    });
    props.onAskAi?.({
      sourceLabel: document.sourceLabel,
      path: document.path,
      title: document.title,
      locator: document.locator,
      selectedText,
    });
  }

  async function downloadAsset(assetPath: string) {
    if (!document || !assetPath) return;
    setError("");
    try {
      const query = new URLSearchParams({ libraryId: document.libraryId, path: assetPath });
      const response = await fetch(`/api/knowledge/asset?${query}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(`knowledge_asset_http_${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = assetPath.split("/").at(-1) || "download";
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "knowledge_asset_download_failed");
    }
  }

  const markdownComponents: Components | undefined = document ? {
    img: ({ src, alt }) => (
      <KnowledgeImage
        libraryId={document.libraryId}
        documentPath={document.path}
        src={typeof src === "string" ? src : ""}
        alt={alt || ""}
      />
    ),
    a: ({ href = "", children }) => {
      if (isExternal(href)) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
      const linked = resolveLinkedPath(document.path, href);
      const markdownPath = MARKDOWN_LINK.test(linked)
        ? linked
        : /\.html$/i.test(linked)
          ? linked.replace(/\.html$/i, ".md")
          : !fileExtension(linked) ? `${linked.replace(/\/$/, "")}/README.md` : "";
      if (markdownPath) {
        return <a href="#" onClick={(event) => { event.preventDefault(); void openDocument(markdownPath); }}>{children}</a>;
      }
      return (
        <a
          href="#"
          className={styles.assetLink}
          title="下载资源"
          onClick={(event) => {
            event.preventDefault();
            void downloadAsset(linked);
          }}
        >
          <DownloadOutlined className={styles.assetDownloadIcon} />
          {children}
        </a>
      );
    },
  } : undefined;

  if (loading && !libraries.length) return <div className={styles.center}><Spin /></div>;

  function renderLibraryGroup(title: string, items: KnowledgeLibrarySummary[], tone: "technical" | "migration") {
    return (
      <section className={styles.libraryGroup} aria-label={title}>
        <h3 className={styles.libraryGroupTitle}>{title}</h3>
        {items.length ? (
          <div className={styles.libraryRows}>
            {items.map((item) => {
              const active = item.libraryId === selectedLibrary?.libraryId;
              return (
                <button
                  key={item.libraryId}
                  type="button"
                  className={`${styles.libraryRow} ${active ? styles.libraryRowActive : ""}`}
                  aria-pressed={active}
                  onClick={() => changeLibrary(item)}
                >
                  <span className={`${styles.libraryDot} ${tone === "technical" ? styles.technicalDot : styles.migrationDot}`} />
                  <span className={styles.libraryName}>{item.label}</span>
                  <span className={styles.libraryCount}>{item.documentCount}</span>
                </button>
              );
            })}
          </div>
        ) : <p className={styles.libraryEmpty}>暂无可访问项目</p>}
      </section>
    );
  }

  return (
    <section className={styles.root}>
      <header className={styles.toolbar}>
        <div className={styles.currentLibrary}>
          <BookOutlined />
          <span>{selectedLibrary?.role === "evidence" ? "迁移案例" : "技术知识库"}</span>
          <span className={styles.currentDivider}>/</span>
          <strong>{selectedLibrary?.label || "知识库"}</strong>
        </div>
        <Popover
          open={searchOpen}
          placement="bottomRight"
          trigger={[]}
          overlayClassName={styles.searchPopover}
          content={(
            <div ref={searchPopupRef} className={styles.searchPopup}>
              <div className={styles.searchPopupTitle}>
                <Text strong>搜索结果</Text>
                {!searching ? <Text type="secondary">{searchHits.length} 条</Text> : null}
              </div>
              {searching ? (
                <div className={styles.searchState}><Spin size="small" /></div>
              ) : searchHits.length ? (
                <div className={styles.results}>
                  {searchHits.map((hit) => (
                    <button
                      key={`${hit.libraryId}:${hit.path}`}
                      className={styles.result}
                      onClick={() => void openDocument(hit.path, hit.libraryId)}
                    >
                      <span className={styles.resultIdentity}>
                        <span className={styles.resultTitle}>{highlightText(hit.title, searchText)}</span>
                        <span className={styles.resultMeta}>{roleLabel(hit.role)} · {hit.sourceLabel}</span>
                      </span>
                      <span className={styles.resultContent}>
                        <span className={styles.resultSummary}>{highlightText(hit.summary, searchText)}</span>
                        <span className={styles.resultPath}>{hit.path}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.searchState}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到相关内容" /></div>
              )}
            </div>
          )}
        >
          <div ref={searchAnchorRef} className={styles.searchAnchor}>
            <Input
              className={styles.search}
              placeholder={`搜索${selectedLibrary?.label || "当前知识库"}`}
              value={searchText}
              prefix={<SearchOutlined />}
              suffix={searching ? <Spin size="small" /> : null}
              allowClear
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchOpen(false);
              }}
              onFocus={() => {
                if (searchText.trim()) setSearchOpen(true);
              }}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </div>
        </Popover>
      </header>
      {error ? <Alert className={styles.alert} type="error" showIcon message="知识内容加载失败" description={error} /> : null}
      <div className={styles.workspace}>
        <aside className={styles.navigation}>
          <div className={styles.libraryPanel}>
            {renderLibraryGroup("技术知识库", technicalLibraries, "technical")}
            {renderLibraryGroup("迁移案例", migrationLibraries, "migration")}
          </div>
          <div className={styles.directoryPanel}>
            <div className={styles.navigationTitle}>
              <FolderOpenOutlined />
              <Text strong>{selectedLibrary?.label || "知识库"} · 目录</Text>
            </div>
            <div ref={directoryBodyRef} className={styles.directoryBody}>
              {tree.length ? (
                <Tree
                  key={selectedLibrary?.libraryId}
                  className={styles.tree}
                  showIcon
                  expandedKeys={expandedKeys}
                  selectedKeys={treeLocation ? [treeLocation.key] : []}
                  treeData={tree.map(function iconize(node): KnowledgeTreeNode & { icon: ReactNode } {
                    return {
                      ...node,
                      icon: node.kind === "directory" ? <FolderOpenOutlined /> : <FileTextOutlined />,
                      children: node.children?.map(iconize),
                    };
                  })}
                  onExpand={(keys) => setExpandedKeys(keys)}
                  onSelect={(_, info) => {
                    const node = info.node as unknown as KnowledgeTreeNode;
                    if (node.kind === "directory" && node.children?.length) {
                      setExpandedKeys((keys) => (
                        keys.includes(node.key)
                          ? keys.filter((key) => key !== node.key)
                          : [...keys, node.key]
                      ));
                      return;
                    }
                    if (node.path) void openDocument(node.path);
                  }}
                />
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识内容" />}
            </div>
          </div>
        </aside>
        <main className={styles.documentPane}>
          {loading && !document ? <div className={styles.center}><Spin /></div> : document ? (
            <>
              <div className={styles.documentHeader}>
                <div className={styles.documentHeading}>
                  <div className={styles.documentMeta}>
                    <Tag color={document.role === "canonical" ? "blue" : "gold"}>{roleLabel(document.role)}</Tag>
                    <Text type="secondary">{document.sourceLabel}</Text>
                  </div>
                  <Title level={2}>{document.title}</Title>
                  <Text type="secondary" className={styles.documentPath}>{document.path}</Text>
                </div>
                <Button icon={<MessageOutlined />} onClick={() => askAi()} disabled={!props.onAskAi}>问 AI</Button>
              </div>
              <article ref={markdownRef} className={styles.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {document.markdown}
                </ReactMarkdown>
                {selectionAsk && props.onAskAi ? (
                  <div
                    data-knowledge-selection-ui
                    className={styles.selectionAsk}
                    style={{ left: selectionAsk.x, top: selectionAsk.y }}
                  >
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        askAi(selectionAsk.text);
                        setSelectionAsk(null);
                        window.getSelection()?.removeAllRanges();
                      }}
                    >
                      <MessageOutlined />
                      问 AI员工
                    </button>
                  </div>
                ) : null}
              </article>
            </>
          ) : (
            <div className={styles.center}><Empty image={<BookOutlined />} description="暂无可阅读文档" /></div>
          )}
        </main>
      </div>
    </section>
  );
}

const MARKDOWN_LINK = /\.md$/i;
