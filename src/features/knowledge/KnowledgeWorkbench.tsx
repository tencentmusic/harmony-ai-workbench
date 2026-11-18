"use client";

import { BookOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Layout, Spin, Typography, theme } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WorkbenchNav } from "@/features/workbench-nav/WorkbenchNav";
import { KnowledgeBrowser } from "./KnowledgeBrowser";
import styles from "./KnowledgeWorkbench.module.css";

const { Sider } = Layout;
const { Text } = Typography;

export function KnowledgeWorkbench() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const token = localStorage.getItem("hm_token") || "";
      if (!token) {
        router.replace("/login");
        return;
      }
      try {
        const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          localStorage.removeItem("hm_token");
          router.replace("/login");
          return;
        }
        if (active) setChecked(true);
      } catch {
        localStorage.removeItem("hm_token");
        router.replace("/login");
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  function logout() {
    localStorage.removeItem("hm_token");
    router.replace("/login");
  }

  if (!checked) {
    return (
      <div className={styles.boot}>
        <Spin />
      </div>
    );
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
        },
        components: {
          Tree: {
            nodeSelectedBg: "#dbe7f7",
            nodeSelectedColor: "#244f87",
          },
        },
      }}
    >
      <div className={styles.root}>
        <Layout hasSider className={styles.layout}>
          <Sider width={260} className={styles.sider}>
            <div className={styles.top}>
              <WorkbenchNav
                current="knowledge"
                onChange={(tab) =>
                  router.push(
                    tab === "knowledge" ? "/knowledge" : `/dashboard?tab=${tab}`,
                  )
                }
              />
            </div>
            <div className={styles.footer}>
              <Button type="text" icon={<LogoutOutlined />} className={styles.logoutBtn} block onClick={logout}>
                退出登录
              </Button>
            </div>
          </Sider>
          <Layout className={styles.main}>
            <div className={styles.header}>
              <Text className={styles.title}>
                <BookOutlined style={{ marginRight: 8 }} />
                知识库
              </Text>
            </div>
            <div className={styles.browserWrap}>
              <KnowledgeBrowser
                onAskAi={(context) => {
                  localStorage.setItem("hm_knowledge_ask", JSON.stringify(context));
                  router.push("/dashboard?tab=chat&intent=knowledge-doc");
                }}
              />
            </div>
          </Layout>
        </Layout>
      </div>
    </ConfigProvider>
  );
}
