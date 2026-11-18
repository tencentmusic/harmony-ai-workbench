"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Dropdown, Empty, Flex, Input, Layout, Modal, Spin, Tooltip, message } from "antd";
import { CommentOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, FileTextOutlined, LogoutOutlined, MenuFoldOutlined, PlusOutlined } from "@ant-design/icons";
import type { ChatSession } from "../types";
import styles from "./SessionSidebar.module.css";
import { MarqueeTitle } from "./MarqueeTitle";
import { WorkbenchNav, type WorkbenchTab } from "@/features/workbench-nav/WorkbenchNav";
import changelog from "../../../../config/changelog.json";
import {
  CHANGELOG_SEEN_STORAGE_KEY,
  changelogSeenToken,
  isChangelogUnread,
  latestRelease,
} from "@/lib/changelog-unread";

const { Sider } = Layout;

type Props = {
  sessions: ChatSession[];
  activeSessionId: string;
  currentTab: WorkbenchTab;
  loadingSessions: boolean;
  chatPanelCollapsed: boolean;
  viewerName: string;
  onCreate: () => void;
  onChatPanelCollapsedChange: (collapsed: boolean) => void;
  onTabChange: (tab: WorkbenchTab) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onLogout: () => void;
};

export function SessionSidebar(props: Props) {
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const latestToken = useMemo(
    () => changelogSeenToken(latestRelease(changelog.releases)),
    [],
  );
  const [changelogUnread, setChangelogUnread] = useState(false);
  const isChatTab = props.currentTab === "chat";
  const showChatPanel = isChatTab && !props.chatPanelCollapsed;

  useEffect(() => {
    try {
      setChangelogUnread(
        isChangelogUnread(latestToken, localStorage.getItem(CHANGELOG_SEEN_STORAGE_KEY)),
      );
    } catch {
      setChangelogUnread(Boolean(latestToken));
    }
  }, [latestToken]);

  function openChangelog() {
    setChangelogOpen(true);
    setChangelogUnread(false);
    try {
      localStorage.setItem(CHANGELOG_SEEN_STORAGE_KEY, latestToken);
    } catch {
      // ignore quota / private mode
    }
  }

  function openRename(id: string, title: string) {
    setRenaming({ id, title });
  }

  function submitRename() {
    if (!renaming) return;
    props.onRename(renaming.id, renaming.title);
    setRenaming(null);
  }

  async function submitFeedback() {
    const content = feedbackText.trim();
    if (!content) return;
    setSubmittingFeedback(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("hm_token") || ""}`,
        },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFeedbackOpen(false);
      setFeedbackText("");
      message.success("反馈已提交");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "反馈提交失败");
    } finally {
      setSubmittingFeedback(false);
    }
  }

  return (
    <Sider width={showChatPanel ? 286 : 56} className={styles.sider}>
      <div className={styles.shell}>
        <div className={styles.rail}>
          <WorkbenchNav current={props.currentTab} onChange={props.onTabChange} />
          <div className={styles.railFooter}>
            <div className={styles.changelogBtnWrap}>
              <Tooltip id="workbench-changelog-tooltip" title="更新日志" placement="right">
                <Button
                  type="text"
                  className={styles.changelogBtn}
                  onClick={openChangelog}
                  aria-label={changelogUnread ? "更新日志，有未读内容" : "更新日志"}
                >
                  <FileTextOutlined className={styles.changelogIcon} />
                  <span className={styles.changelogText}>日志</span>
                </Button>
              </Tooltip>
              {changelogUnread ? <span className={styles.changelogUnreadDot} aria-hidden /> : null}
            </div>
            <Button type="text" className={styles.feedbackBtn} onClick={() => setFeedbackOpen(true)}>
              <CommentOutlined className={styles.feedbackIcon} />
              <span className={styles.feedbackText}>反馈</span>
            </Button>
            <div className={styles.userInfo}>
              <Tooltip id="workbench-viewer-tooltip" title={props.viewerName || "未命名用户"} placement="right">
                <button type="button" className={styles.logoutIconBtn} aria-label="退出登录" onClick={props.onLogout}>
                  <LogoutOutlined />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
        {showChatPanel ? (
          <div className={styles.panel}>
            <div className={styles.top}>
              <div className={styles.topRow}>
                <Button className={styles.newBtn} icon={<PlusOutlined />} block onClick={props.onCreate}>
                    新建任务
                </Button>
                <Button
                  className={styles.panelToggleBtn}
                  type="text"
                  icon={<MenuFoldOutlined />}
                  onClick={() => props.onChatPanelCollapsedChange(true)}
                  aria-label="收起会话面板"
                />
              </div>
            </div>
            <div className={styles.list}>
              {props.loadingSessions ? <Spin /> : null}
              {!props.loadingSessions && !props.sessions.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" /> : null}
                {props.sessions.map((s) => (
                  <div key={s.id} className={`${styles.item} ${s.id === props.activeSessionId ? styles.active : ""}`} onClick={() => props.onSelect(s.id)}>
                    <Flex className={styles.itemRow} align="center" justify="space-between" gap={8}>
                      <div className={styles.itemMain}>
                        <MarqueeTitle className={styles.itemTitle} text={s.title} />
                      </div>
                    {s.id === props.activeSessionId ? (
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: [
                            { key: "rename", icon: <EditOutlined />, label: "重命名会话" },
                            { type: "divider" },
                            { key: "delete", icon: <DeleteOutlined />, danger: true, label: "删除会话" },
                          ],
                          onClick: ({ key }) => {
                            if (key === "rename") openRename(s.id, s.title);
                            if (key === "delete") props.onDelete(s.id);
                          },
                        }}
                      >
                        <Button
                          size="small"
                          type="text"
                          icon={<EllipsisOutlined />}
                          className={styles.menuBtn}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Dropdown>
                    ) : null}
                  </Flex>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <Modal
        title="重命名会话"
        open={!!renaming}
        onCancel={() => setRenaming(null)}
        onOk={submitRename}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !renaming?.title.trim() }}
      >
        <Input value={renaming?.title || ""} onChange={(e) => setRenaming((prev) => (prev ? { ...prev, title: e.target.value } : prev))} maxLength={80} />
      </Modal>
      <Modal
        title="反馈问题"
        open={feedbackOpen}
        onCancel={() => setFeedbackOpen(false)}
        footer={null}
        width={432}
        centered
        className={styles.feedbackModal}
      >
        <div className={styles.feedbackIntro}>反馈工台问题或提出改进建议:</div>
        <Input.TextArea
          className={styles.feedbackTextarea}
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          maxLength={200}
          showCount
          placeholder="请输入您要反馈的问题（200字以内）"
        />
        <Button className={styles.feedbackSubmitBtn} type="primary" block loading={submittingFeedback} disabled={!feedbackText.trim()} onClick={() => void submitFeedback()}>
          提交
        </Button>
      </Modal>
      <Modal
        title="更新日志"
        open={changelogOpen}
        onCancel={() => setChangelogOpen(false)}
        footer={null}
        width={760}
        centered
        className={styles.changelogModal}
      >
        <div className={styles.changelogTimeline}>
          {changelog.releases.map((release) => (
            <section key={release.version} className={styles.releaseItem}>
              <div className={styles.releaseDotWrap}>
                <span className={`${styles.releaseDot} ${release.latest ? styles.releaseDotLatest : ""}`} />
              </div>
              <div className={styles.releaseCard}>
                <div className={styles.releaseHead}>
                  <div className={styles.releaseVersion}>{release.version}</div>
                  <div className={styles.releaseDate}>{release.date}</div>
                  {release.latest ? <span className={styles.releaseLatest}>最新</span> : null}
                </div>
                <ul className={styles.releaseList}>
                  {release.items.map((item) => (
                    <li key={item} className={styles.releaseListItem}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>
      </Modal>
    </Sider>
  );
}
