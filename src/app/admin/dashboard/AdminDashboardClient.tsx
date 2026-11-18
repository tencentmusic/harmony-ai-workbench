"use client";

import dynamic from "next/dynamic";

const AdminConsole = dynamic(() => import("@/features/admin-console/AdminConsole").then((m) => m.AdminConsole), {
  ssr: false,
});

export function AdminDashboardClient() {
  return <AdminConsole />;
}
