"use client";

import { useSearchParams } from "next/navigation";
import { LoginPortal } from "./LoginPortal";

export function AdminLogin() {
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");
  const reasonText =
    reason === "forbidden"
      ? "管理员密钥校验失败或已过期，请重新输入。"
      : reason === "missing"
        ? "未检测到管理员登录态，请先登录。"
        : "";
  return <LoginPortal initialMode="admin" reasonText={reasonText} />;
}

