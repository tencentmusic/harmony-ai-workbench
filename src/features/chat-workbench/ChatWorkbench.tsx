"use client";

import { App, ConfigProvider, Layout, theme } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ComposerDock } from "./components/ComposerDock";
import { ConversationPane } from "./components/ConversationPane";
import { SessionSidebar } from "./components/SessionSidebar";
import { useChatWorkbench } from "./hooks/useChatWorkbench";
import { KnowledgeBrowser } from "@/features/knowledge/KnowledgeBrowser";
// Keep CloudAgent CSS owned by the dashboard entry across hot updates.
import { CloudAgent } from "@/features/cloud-agent/CloudAgent";
import { IntegrationWorkbench } from "@/features/integration-workbench/IntegrationWorkbench";
import { McpGuidePanel } from "@/features/mcp-guide/McpGuidePanel";
import { PackageComparisonWorkbench } from "@/features/package-comparison/PackageComparison";
import { ImageCompressionWorkbench } from "@/features/image-compression/ImageCompressionWorkbench";
import type { WorkbenchTab } from "@/features/workbench-nav/WorkbenchNav";
import type { KnowledgeLocator } from "@/contracts/knowledge";
import styles from "./ChatWorkbench.module.css";

function readTabFromLocation(): WorkbenchTab {
  const params = new URLSearchParams(window.location.search || "");
  if (params.get("tab") === "integration") return "integration";
  if (params.get("tab") === "cloud-agent") return "cloud-agent";
  if (params.get("tab") === "mcp") return "mcp";
  if (params.get("tab") === "chat") return "chat";
  if (params.get("tab") === "package-comparison") return "package-comparison";
  if (params.get("tab") === "image-compression") return "image-compression";
  return params.get("intent") === "class-explain" ? "chat" : "knowledge";
}

type KnowledgeAskContext = {
  locator?: KnowledgeLocator;
  sourceLabel?: string;
  path?: string;
  title?: string;
  selectedText?: string;
};

function knowledgeAskPrompt(context: KnowledgeAskContext) {
  const documentName = context.title || context.path || "当前文档";
  const base = `请结合${context.sourceLabel || "知识库"}文档《${documentName}》（${context.path || "路径未提供"}）分析`;
  if (!context.selectedText) return `${base}，并说明当前源码是否仍一致。`;
  const quote = context.selectedText.split("\n").map((line) => `> ${line}`).join("\n");
  return `${base}，重点说明以下选中内容的业务含义、双端实现关系，并核验当前源码是否仍一致：\n\n${quote}`;
}

export function ChatWorkbench() {
  const router = useRouter();
  const { message } = App.useApp();
  const vm = useChatWorkbench(router);
  const [hydrated, setHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("knowledge");
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false);
  const [knowledgeMounted, setKnowledgeMounted] = useState(false);
  const [integrationMounted, setIntegrationMounted] = useState(false);
  const [cloudAgentMounted, setCloudAgentMounted] = useState(false);
  const [mcpMounted, setMcpMounted] = useState(false);
  const [packageMounted, setPackageMounted] = useState(false);
  const [compressionMounted, setCompressionMounted] = useState(false);

  useEffect(() => {
    setActiveTab(readTabFromLocation());
    const params = new URLSearchParams(window.location.search || "");
    if (params.get("intent") === "knowledge-doc") {
      try {
        const context = JSON.parse(localStorage.getItem("hm_knowledge_ask") || "{}") as KnowledgeAskContext;
        if (context.locator?.appScopeId) vm.setAppScopeId(context.locator.appScopeId);
        if (context.path) {
          vm.setKnowledgeQuestion(knowledgeAskPrompt(context), context.locator);
        }
        localStorage.removeItem("hm_knowledge_ask");
      } catch {
        localStorage.removeItem("hm_knowledge_ask");
      }
    }
    setHydrated(true);
    // 仅在进入工作台时消费一次跨页面知识上下文。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (activeTab === "knowledge") setKnowledgeMounted(true);
    if (activeTab === "integration") setIntegrationMounted(true);
    if (activeTab === "cloud-agent") setCloudAgentMounted(true);
    if (activeTab === "mcp") setMcpMounted(true);
    if (activeTab === "package-comparison") setPackageMounted(true);
    if (activeTab === "image-compression") setCompressionMounted(true);
  }, [activeTab, hydrated]);

  const changeTab = useCallback((tab: WorkbenchTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    if (tab !== "chat") {
      url.searchParams.delete("intent");
      url.searchParams.delete("classFqn");
      url.searchParams.delete("docPath");
    }
    window.history.replaceState(window.history.state, "", url);
  }, []);

  useEffect(() => {
    if (!vm.err) return;
    message.error(vm.err);
  }, [message, vm.err]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const payload = event.data as { type?: string; classFqn?: string; docPath?: string } | null;
      if (!payload || payload.type !== "kg-docs-open-class" || !payload.classFqn) return;
      changeTab("chat");
      vm.openClassExplain(payload.classFqn, payload.docPath || "");
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [changeTab, vm.openClassExplain]);

  function logout() {
    localStorage.removeItem("hm_token");
    setCloudAgentMounted(false);
    window.dispatchEvent(new Event('cloud-agent-auth-invalid'));
    router.replace("/login");
  }

  async function copyText(content: string) {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      message.success("内容已复制到剪贴板");
    } catch {
      message.error("复制失败，请检查浏览器权限");
    }
  }

  function exportText(content: string) {
    if (!content) return;
    const baseName = vm.selectedClasses[0]?.fqn || vm.sessionTitle || "chat";
    const safe = baseName.replace(/[^\w.-]+/g, "_").slice(-80) || "chat";
    const fileName = `AI对话_${safe}.txt`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出：${fileName}`);
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#111827",
          borderRadius: 10,
          colorBgBase: "#ffffff",
          colorTextBase: "#1f2937",
          controlOutline: "rgba(76, 111, 255, 0.14)",
          controlOutlineWidth: 1,
        },
        components: {
          Input: {
            activeBorderColor: "#c5d2f6",
            hoverBorderColor: "#d5deef",
            activeShadow: "0 0 0 1px rgba(76, 111, 255, 0.14)",
          },
          InputNumber: {
            activeBorderColor: "#c5d2f6",
            hoverBorderColor: "#d5deef",
            activeShadow: "0 0 0 1px rgba(76, 111, 255, 0.14)",
          },
          Select: {
            activeBorderColor: "#c5d2f6",
            hoverBorderColor: "#d5deef",
            activeOutlineColor: "rgba(76, 111, 255, 0.14)",
            optionSelectedBg: "#eef2ff",
            optionSelectedColor: "#1f2430",
            optionActiveBg: "#f4f7fb",
          },
          DatePicker: {
            activeBorderColor: "#c5d2f6",
            hoverBorderColor: "#d5deef",
            activeShadow: "0 0 0 1px rgba(76, 111, 255, 0.14)",
          },
        },
      }}
    >
      <div className={`${styles.root} ${hydrated ? styles.rootReady : styles.rootBoot}`}>
        <Layout hasSider className={styles.layout}>
          <SessionSidebar
            sessions={vm.sessions}
            activeSessionId={vm.activeSessionId}
            currentTab={activeTab}
            chatPanelCollapsed={chatPanelCollapsed}
            loadingSessions={vm.loadingSessions}
            viewerName={vm.viewer?.personName || ""}
            onChatPanelCollapsedChange={setChatPanelCollapsed}
            onTabChange={changeTab}
            onCreate={() => void vm.createSession("新会话")}
            onSelect={vm.setActiveSessionId}
            onDelete={(id) => void vm.deleteSession(id)}
            onRename={(id, title) => void vm.renameSession(id, title)}
            onLogout={logout}
          />
          <Layout className={styles.main}>
            <div className={`${styles.chatPane} ${activeTab === "chat" ? "" : styles.hiddenPane}`}>
              <ConversationPane
                activeSessionId={vm.activeSessionId}
                title={vm.sessionTitle}
                messages={vm.messages}
                hasMoreMessages={vm.hasMoreMessages}
                loadingMoreMessages={vm.loadingMoreMessages}
                loadingMessages={vm.loadingMessages}
                sending={vm.activeSessionSending}
                forceStickBottomTick={vm.forceStickBottomTick}
                streamingReply={vm.streamingReply}
                streamingImages={vm.streamingImages}
                streamingStatus={vm.streamingStatus}
                showExpandPanelButton={chatPanelCollapsed}
                onLoadOlderMessages={vm.loadOlderMessages}
                onExpandPanel={() => setChatPanelCollapsed(false)}
                onAdmin={() => router.push("/admin/login")}
                onCopy={(text) => void copyText(text)}
                onExport={exportText}
                onQuickPrompt={vm.setInputText}
              />
              <ComposerDock
                inputText={vm.inputText}
                sending={vm.activeSessionSending}
                canceling={vm.canceling}
                canSend={vm.canSend}
                attachments={vm.attachments}
                uploadingAttachments={vm.uploadingAttachments}
                appScopes={vm.appScopes}
                appScopeId={vm.appScopeId}
                selectedClasses={vm.selectedClasses}
                classCandidates={vm.classCandidates}
                classSearching={vm.classSearching}
                showClassSearchPanel={vm.showClassSearchPanel}
                onInputTextChange={vm.setInputText}
                onUploadFiles={(files) => void vm.uploadAttachments(files)}
                onRemoveAttachment={vm.removeAttachment}
                onAppScopeChange={vm.setAppScopeId}
                onPickClass={vm.pickClassCandidate}
                onRemoveClass={vm.removeSelectedClass}
                onSend={() => void vm.sendMessage()}
                onCancelSend={vm.cancelSending}
              />
            </div>
            {knowledgeMounted ? (
              <div className={`${styles.knowledgePane} ${activeTab === "knowledge" ? "" : styles.hiddenPane}`}>
                <KnowledgeBrowser
                  appScopeId={vm.appScopeId === "all" ? undefined : vm.appScopeId}
                  onAppScopeChange={vm.setAppScopeId}
                  onAskAi={(context) => {
                    if (context.locator.appScopeId) vm.setAppScopeId(context.locator.appScopeId);
                    vm.setKnowledgeQuestion(knowledgeAskPrompt(context), context.locator);
                    changeTab("chat");
                  }}
                />
              </div>
            ) : null}
            {integrationMounted ? (
              <div
                className={`${styles.integrationPane} ${
                  activeTab === "integration" ? "" : styles.hiddenPane
                }`}
              >
                <IntegrationWorkbench active={activeTab === "integration"} />
              </div>
            ) : null}
            {cloudAgentMounted ? <div className={`${styles.integrationPane} ${activeTab === 'cloud-agent' ? '' : styles.hiddenPane}`}><CloudAgent active={activeTab === 'cloud-agent'} /></div> : null}
            {mcpMounted ? (
              <div className={`${styles.mcpPane} ${activeTab === "mcp" ? "" : styles.hiddenPane}`}>
                <McpGuidePanel />
              </div>
            ) : null}
            {packageMounted && (
              <div className={`${styles.toolPane} ${activeTab === "package-comparison" ? "" : styles.hiddenPane}`}>
                <PackageComparisonWorkbench />
              </div>
            )}
            {compressionMounted && (
              <div className={`${styles.toolPane} ${activeTab === "image-compression" ? "" : styles.hiddenPane}`}>
                <ImageCompressionWorkbench />
              </div>
            )}
          </Layout>
        </Layout>
      </div>
    </ConfigProvider>
  );
}
