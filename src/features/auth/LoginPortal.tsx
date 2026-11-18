"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, ConfigProvider, Input, Space, Typography, theme } from "antd";
import { LockOutlined, LoginOutlined, SafetyCertificateOutlined, SwapOutlined } from "@ant-design/icons";
import { KugouHarmonyAiIcon } from "@/features/admin-console/components/KugouHarmonyAiIcon";
import styles from "./LoginPortal.module.css";

const { Title, Text, Link } = Typography;

type Props = {
  initialMode?: "user" | "admin";
  reasonText?: string;
};

export function LoginPortal({ initialMode = "user", reasonText = "" }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"user" | "admin">(initialMode);
  const [turning, setTurning] = useState(false);
  const turnTimer = useRef<number | null>(null);

  function switchMode(next: "user" | "admin") {
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    setTurning(true);
    setMode(next);
    turnTimer.current = window.setTimeout(() => setTurning(false), 620);
  }
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [userBusy, setUserBusy] = useState(false);
  const [userErr, setUserErr] = useState("");

  async function enterUser() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setUserBusy(true);
    setUserErr("");
    try {
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("hm_token");
        setUserErr("Token 无效或已过期，请联系管理员重新发放。");
        return;
      }
      if (!res.ok) {
        setUserErr(`登录校验失败（HTTP ${res.status}）`);
        return;
      }
      localStorage.setItem("hm_token", trimmed);
      router.replace("/dashboard");
    } catch (e) {
      setUserErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUserBusy(false);
    }
  }

  async function enterAdmin() {
    const trimmed = secret.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/auth-check", { headers: { "x-admin-secret": trimmed } });
      if (res.status === 403) {
        localStorage.removeItem("hm_admin_secret");
        setErr("管理员密钥不正确，请检查后重试。");
        return;
      }
      if (!res.ok) {
        setErr(`登录校验失败（HTTP ${res.status}）`);
        return;
      }
      localStorage.setItem("hm_admin_secret", trimmed);
      router.replace("/admin/dashboard");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1f5fd7",
          colorBgBase: "#ffffff",
          colorTextBase: "#1f2937",
          borderRadius: 10,
        },
      }}
    >
      <div className={styles.root}>
        <div className={styles.leftPane}>
          <div className={styles.brandRow}>
            <div className={styles.brandIconWrap}>
              <KugouHarmonyAiIcon size={54} />
            </div>
            <div className={styles.brandName}>Harmony AI Workbench</div>
          </div>

          <div className={styles.capabilityFlow}>
            <svg className={styles.snakeSvg} viewBox="0 0 860 520" preserveAspectRatio="none" aria-hidden="true">
              <path vectorEffect="non-scaling-stroke" d="M260 28H500A56 56 0 0 1 500 140H360A56 56 0 0 0 360 252H500A56 56 0 0 1 500 364H360A56 56 0 0 0 360 476H600" />
            </svg>
            <div className={styles.avatarField} aria-hidden="true">
              <img
                className={`${styles.avatarBubble} ${styles.avatarOne}`}
                src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&crop=faces&w=120&h=120&q=80"
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
              <img
                className={`${styles.avatarBubble} ${styles.avatarTwo}`}
                src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&crop=faces&w=96&h=96&q=80"
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
              <img
                className={`${styles.avatarBubble} ${styles.avatarThree}`}
                src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&crop=faces&w=120&h=120&q=80"
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
              <img
                className={`${styles.avatarBubble} ${styles.avatarFour}`}
                src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&crop=faces&w=96&h=96&q=80"
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            </div>

            <div className={styles.flowPad} />
            <div className={`${styles.flowRow} ${styles.row1} ${styles.stepLeft}`}>
              <p className={`${styles.flowDesc} ${styles.descLeft}`}>查业务规则、双端代码地图和设计资源</p>
              <div className={styles.flowCore}>
                <span className={styles.flowLabel}>知识库</span>
              </div>
              <span className={styles.descPlaceholder} />
            </div>

            <div className={`${styles.flowRow} ${styles.row2} ${styles.stepRight}`}>
              <span className={styles.descPlaceholder} />
              <div className={styles.flowCore}>
                <span className={styles.flowLabel}>AI员工</span>
              </div>
              <p className={`${styles.flowDesc} ${styles.descRight}`}>对着知识和源码提问，追调用链和端间差异</p>
            </div>

            <div className={`${styles.flowRow} ${styles.row3} ${styles.stepLeft}`}>
              <p className={`${styles.flowDesc} ${styles.descLeft}`}>从需求走到鸿蒙harness转译、审查和验收</p>
              <div className={styles.flowCore}>
                <span className={styles.flowLabel}>转译台</span>
              </div>
              <span className={styles.descPlaceholder} />
            </div>

            <div className={`${styles.flowRow} ${styles.row4} ${styles.stepRight}`}>
              <span className={styles.descPlaceholder} />
              <div className={styles.flowCore}>
                <span className={styles.flowLabel}>集成台</span>
              </div>
              <p className={`${styles.flowDesc} ${styles.descRight}`}>把分支、审查和测试收成一条合入流水线</p>
            </div>
            <div className={styles.flowTail} />
          </div>
        </div>

        <div className={styles.rightPane}>
          <div className={styles.scene}>
            <div className={`${styles.flipper} ${mode === "admin" ? styles.isAdmin : ""} ${turning ? styles.isTurning : ""}`}>
              <div className={`${styles.face} ${styles.faceFront}`}>
                <Card className={styles.card}>
                  <Space direction="vertical" size={16} style={{ width: "100%" }}>
                    <div className={styles.cardHeader}>
                      <Space>
                        <SafetyCertificateOutlined />
                        <Text className={styles.caption}>驻场访问入口</Text>
                      </Space>
                      <Link className={`${styles.switchLink} ${styles.headerSwitchLink}`} onClick={() => switchMode("admin")}>
                        <SwapOutlined />
                        <span>管理员登录</span>
                      </Link>
                    </div>
                    <Title level={2} style={{ margin: 0 }}>
                      驻场工作台登录
                    </Title>
                    {userErr ? <Alert type="error" showIcon message={userErr} /> : null}
                    <Input.Password className={styles.input} placeholder="请输入 API Token（hm_...）" value={token} onChange={(e: ChangeEvent<HTMLInputElement>) => { setToken(e.target.value); setUserErr(""); }} onPressEnter={() => void enterUser()} />
                    <Space>
                      <Button className={styles.enterBtn} type="primary" icon={<LoginOutlined />} loading={userBusy} disabled={!token.trim()} onClick={() => void enterUser()}>
                        进入工作台
                      </Button>
                    </Space>
                    <Text className={styles.hint}>提示：Token 仅在创建时显示一次，请及时保存。</Text>
                  </Space>
                </Card>
              </div>

              <div className={`${styles.face} ${styles.faceBack}`}>
                <Card className={styles.card}>
                  <Space direction="vertical" size={16} style={{ width: "100%" }}>
                    <div className={styles.cardHeader}>
                      <Space>
                        <LockOutlined />
                        <Text className={styles.caption}>管理员后台入口</Text>
                      </Space>
                      <Link className={`${styles.switchLink} ${styles.headerSwitchLink}`} onClick={() => switchMode("user")}>
                        <SwapOutlined />
                        <span>返回驻场登录</span>
                      </Link>
                    </div>
                    <Title level={2} style={{ margin: 0 }}>
                      管理后台登录
                    </Title>
                    {reasonText ? <Alert type="info" showIcon message={reasonText} /> : null}
                    {err ? <Alert type="error" showIcon message={err} /> : null}
                    <Input.Password className={styles.input} placeholder="请输入管理员密钥" value={secret} onChange={(e: ChangeEvent<HTMLInputElement>) => setSecret(e.target.value)} onPressEnter={() => void enterAdmin()} />
                    <Space style={{ width: "100%", justifyContent: "space-between" }}>
                      <Button className={styles.enterBtn} type="primary" loading={busy} disabled={!secret.trim()} onClick={() => void enterAdmin()}>
                        {busy ? "校验中..." : "进入后台"}
                      </Button>
                    </Space>
                    <Text className={styles.hint}>请仅在内网可信环境使用后台管理功能。</Text>
                  </Space>
                </Card>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}
