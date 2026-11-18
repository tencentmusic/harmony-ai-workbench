import { Suspense } from "react";
import { AdminLogin } from "@/features/auth/AdminLogin";

export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <AdminLogin />
    </Suspense>
  );
}
