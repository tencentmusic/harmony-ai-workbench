"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { MenuProps } from "antd";
import { Alert, App, Button, ConfigProvider, Layout, Menu, Skeleton, Space, Typography, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AdminTablePageSizeProvider } from "./context/AdminTablePageSizeContext";
import { ApiOutlined, BarChartOutlined, BookOutlined, BulbOutlined, ClockCircleOutlined, ClusterOutlined, CommentOutlined, FundProjectionScreenOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined, RocketOutlined, SettingOutlined, SyncOutlined, TeamOutlined } from "@ant-design/icons";
import { useAdminConsole } from "./hooks/useAdminConsole";
import { useAdminTheme } from "./hooks/useAdminTheme";
import { RequestsPanel } from "./components/RequestsPanel";
import { TokensPanel } from "./components/TokensPanel";
import { UsagePanel } from "./components/UsagePanel";
import { FeedbackPanel } from "./components/FeedbackPanel";
import { KnowledgeStatsPanel } from "./components/KnowledgeStatsPanel";
import { RepoSyncPanel } from "./components/RepoSyncPanel";
import { KbRoiStatsPanel } from "./components/KbRoiStatsPanel";
import { ZcMcpAuditPanel } from "./components/ZcMcpAuditPanel";
import { KugouHarmonyAiIcon } from "./components/KugouHarmonyAiIcon";
import { defaultOpenKeysForMenu, isMenuLeafKey } from "./lib/adminMenuConfig";
import type { MenuKey } from "./types";

const { Sider, Header, Content } = Layout;
const { Text } = Typography;
const OverviewPanel = dynamic(() => import("./components/OverviewPanel").then((m) => m.OverviewPanel), { ssr: false });

export function AdminConsole() {
  const router = useRouter();
  const { message } = App.useApp();
  const vm = useAdminConsole(router, message);
  const ui = useAdminTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(["kb", "ai", "system"]);

  const menuItems: MenuProps["items"] = useMemo(
    () => [
      { key: "overview", icon: <FundProjectionScreenOutlined />, label: "仪表盘" },
      {
        key: "kb",
        icon: <BookOutlined />,
        label: "知识库",
        children: [
          { key: "kbRoi", icon: <ClusterOutlined />, label: "知识库看板" },
          { key: "repoSync", icon: <SyncOutlined />, label: "自动更新记录" },
          { key: "knowledge", icon: <BookOutlined />, label: "迁移文档看板" },
        ],
      },
      {
        key: "ai",
        icon: <CommentOutlined />,
        label: "AI 问答",
        children: [
          { key: "usage", icon: <BarChartOutlined />, label: "问答统计" },
          { key: "requests", icon: <ClockCircleOutlined />, label: "问答记录" },
          { key: "zcMcpAudit", icon: <ApiOutlined />, label: "MCP记录" },
        ],
      },
      {
        key: "system",
        icon: <SettingOutlined />,
        label: "系统配置",
        children: [
          { key: "tokens", icon: <TeamOutlined />, label: "Token 管理" },
          { key: "feedback", icon: <CommentOutlined />, label: "用户反馈" },
        ],
      },
    ],
    [],
  );

  useEffect(() => {
    setOpenKeys((prev) => {
      const next = defaultOpenKeysForMenu(vm.menuKey);
      return next.length ? [...new Set([...prev, ...next])] : prev;
    });
  }, [vm.menuKey]);
  const renderMenuSkeleton = () => (
    <Space className="admin-boot-skeleton" direction="vertical" size={16} style={{ width: "100%" }}>
      <Skeleton active title={{ width: 220 }} paragraph={false} />
      <Skeleton active paragraph={{ rows: 3 }} />
      <Skeleton active paragraph={{ rows: 5 }} />
    </Space>
  );

  return (
    <ConfigProvider locale={zhCN} theme={{ inherit: false, algorithm: ui.isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <AdminTablePageSizeProvider>
      <Layout className={`admin-root ${ui.isDark ? "admin-dark" : "admin-light"}`}>
        <Sider width={230} collapsedWidth={72} collapsible collapsed={collapsed} trigger={null} onCollapse={setCollapsed} className="admin-sider" theme={ui.isDark ? "dark" : "light"}>
          <div className="admin-logo">
            <KugouHarmonyAiIcon size={40} />
            {!collapsed ? <span>Harmony AI Workbench</span> : null}
          </div>
          <Menu
            mode="inline"
            theme={ui.isDark ? "dark" : "light"}
            inlineCollapsed={collapsed}
            selectedKeys={[vm.menuKey]}
            openKeys={collapsed ? [] : openKeys}
            onOpenChange={(keys) => setOpenKeys(keys)}
            items={menuItems}
            style={{ background: "transparent", borderInlineEnd: "none" }}
            onClick={(e: Parameters<NonNullable<MenuProps["onClick"]>>[0]) => {
              if (isMenuLeafKey(e.key)) vm.setMenuKey(e.key);
            }}
          />
        </Sider>
        <Layout>
          <Header className="admin-header">
            <Space className="admin-header-left">
              <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((v) => !v)} />
              <RocketOutlined />
              <Text>Harmony AI Workbench · 管理后台</Text>
            </Space>
            <Space>
              <Button type="text" icon={ui.isDark ? <BulbOutlined /> : <MoonOutlined />} onClick={ui.toggleTheme}>
                {ui.isDark ? "浅色" : "深色"}
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => router.push("/dashboard")}>
                工作台
              </Button>
              <Button icon={<LogoutOutlined />} onClick={vm.logout}>
                退出
              </Button>
            </Space>
          </Header>
          <Content className="admin-content">
            {vm.ok ? (
              <Alert style={{ marginBottom: 12 }} type="success" message={vm.ok} showIcon closable onClose={vm.clearFlash} />
            ) : null}
            {vm.err ? (
              <Alert style={{ marginBottom: 12 }} type="error" message={vm.err} showIcon closable onClose={vm.clearFlash} />
            ) : null}

            {vm.booting ? (
              renderMenuSkeleton()
            ) : vm.menuLoading || vm.busy ? (
              renderMenuSkeleton()
            ) : (
              <>
                {vm.menuKey === "overview" ? (
                  <OverviewPanel
                    isDark={ui.isDark}
                    chartRange={vm.overviewChartRange}
                    chartRangeLabel={vm.overview.chartRangeLabel}
                    chartLoading={vm.busy}
                    onChartRangeChange={(range) => void vm.changeOverviewChartRange(range)}
                    tokenCount={vm.overview.tokenCount}
                    appCount={vm.overview.appCount}
                    migrationDocCount={vm.overview.migrationDocCount}
                    taskTotalAllTime={vm.overview.taskTotalAllTime}
                    usageSummary={vm.overview.usageSummary}
                    line7d={vm.overview.line7d}
                    person7d={vm.overview.person7d}
                    personRank={vm.overview.personRank}
                  />
                ) : null}
                {vm.menuKey === "knowledge" ? (
                  <KnowledgeStatsPanel
                    busy={vm.busy}
                    days={vm.knowledgeStats.days}
                    migrationDocCount={vm.knowledgeStats.migrationDocCount}
                    hotDocs={vm.knowledgeStats.hotDocs}
                    coldDocs={vm.knowledgeStats.coldDocs}
                    personStats={vm.knowledgeStats.personStats}
                    onDaysChange={(days) => void vm.changeKnowledgeDays(days)}
                    onRefresh={() => void vm.refreshKnowledgeStats()}
                  />
                ) : null}
                {vm.menuKey === "kbRoi" ? (
                  <KbRoiStatsPanel
                    busy={vm.busy}
                    range={vm.kbRoiRange}
                    error={vm.kbRoiStats.error}
                    kpi={vm.kbRoiStats.kpi}
                    byFeature={vm.kbRoiStats.byFeature}
                    byDelivery={vm.kbRoiStats.byDelivery}
                    cohort={vm.kbRoiStats.cohort}
                    daily={vm.kbRoiStats.daily}
                    byCodegraphTool={vm.kbRoiStats.byCodegraphTool}
                    onRangeChange={(range) => void vm.changeKbRoiRange(range)}
                  />
                ) : null}
                {vm.menuKey === "repoSync" ? (
                  <RepoSyncPanel
                    busy={vm.busy}
                    queueDepth={vm.repoSyncQueueDepth}
                    repos={vm.repoSyncRepos}
                    runs={vm.repoSyncRuns}
                    rebuildingClassIndex={vm.rebuildingClassIndex}
                    onRefresh={() => void vm.refreshRepoSync()}
                    onTrigger={(repoId, branch) => void vm.triggerRepoSync(repoId, branch)}
                    onRebuildIndex={() => void vm.rebuildClassIndex()}
                  />
                ) : null}
                {vm.menuKey === "tokens" ? <TokensPanel creatingToken={vm.creatingToken} tokenForm={vm.tokenForm} tokenOnce={vm.tokenOnce} tokens={vm.tokens} appScopes={vm.appScopes} onTokenFormChange={vm.setTokenForm} onCreate={() => void vm.createToken()} onPatch={(id, revoked) => void vm.patchToken(id, revoked)} onRecreate={(id) => void vm.recreateToken(id)} onUpdateScopes={(id, appScopeIds) => void vm.updateTokenScopes(id, appScopeIds)} onViewRequests={(tokenId) => { vm.setMenuKey("requests"); vm.setRecordTokenId(tokenId); void vm.fetchRequestRows(tokenId, vm.requestDateRange, vm.requestStatus); }} /> : null}
                {vm.menuKey === "usage" ? <UsagePanel busy={vm.busy} usage={vm.usageRows} tokens={vm.tokens} tokenId={vm.usageTokenId} dateRange={vm.usageDateRange} onTokenChange={vm.setUsageTokenId} onDateRangeChange={vm.setUsageDateRange} onRefresh={() => void vm.refreshUsageRows()} /> : null}
                {vm.menuKey === "requests" ? <RequestsPanel busy={vm.busy} recordTokenId={vm.recordTokenId} requestStatus={vm.requestStatus} dateRange={vm.requestDateRange} tokens={vm.tokens} requestRows={vm.requestRows} isDark={ui.isDark} onDateRangeChange={vm.setRequestDateRange} onTokenChange={vm.setRecordTokenId} onStatusChange={vm.setRequestStatus} onRefresh={() => void vm.refreshRequestRows()} /> : null}
                {vm.menuKey === "feedback" ? <FeedbackPanel busy={vm.busy} rows={vm.feedbackRows} onRefresh={() => void vm.refreshFeedbackRows()} /> : null}
                {vm.menuKey === "zcMcpAudit" ? (
                  <ZcMcpAuditPanel
                    busy={vm.busy}
                    days={vm.zcMcpAuditDays}
                    consumer={vm.zcMcpAuditConsumer}
                    apiTokenId={vm.zcMcpAuditTokenId}
                    tool={vm.zcMcpAuditTool}
                    eventType={vm.zcMcpAuditEventType}
                    hit={vm.zcMcpAuditHit}
                    dateRange={vm.zcMcpAuditDateRange}
                    tokens={vm.tokens}
                    rows={vm.zcMcpAuditRows}
                    total={vm.zcMcpAuditTotal}
                    byTool={vm.zcMcpAuditByTool}
                    byConsumer={vm.zcMcpAuditByConsumer}
                    onDaysChange={vm.setZcMcpAuditDays}
                    onDateRangeChange={vm.setZcMcpAuditDateRange}
                    onConsumerChange={vm.setZcMcpAuditConsumer}
                    onTokenChange={vm.setZcMcpAuditTokenId}
                    onToolChange={vm.setZcMcpAuditTool}
                    onEventTypeChange={vm.setZcMcpAuditEventType}
                    onHitChange={vm.setZcMcpAuditHit}
                    onRefresh={() => void vm.refreshZcMcpAuditRows()}
                  />
                ) : null}
              </>
            )}
          </Content>
        </Layout>
      </Layout>
      </AdminTablePageSizeProvider>
    </ConfigProvider>
  );
}

