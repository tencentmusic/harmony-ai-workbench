"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spin, Typography } from "antd";

const { Text } = Typography;

export function HomeRedirect() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void (async () => {
      const t = localStorage.getItem("hm_token");
      if (!t) {
        if (active) router.replace("/login");
        return;
      }
      try {
        const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${t}` } });
        if (!active) return;
        if (res.ok) {
          router.replace("/dashboard");
          return;
        }
      } catch {
        // fall through to clear and login
      }
      localStorage.removeItem("hm_token");
      if (active) router.replace("/login");
    })();
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="login-wrap">
      <Spin />
      <Text style={{ marginLeft: 12 }}>正在跳转...</Text>
    </div>
  );
}

