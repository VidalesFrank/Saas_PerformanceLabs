"use client";

import { Sidebar } from "@/components/sidebar";
import { useRequireAuth } from "@/lib/use-require-auth";

/** Shell compartido por todas las herramientas autenticadas: sidebar persistente
 * + guard de sesión centralizado (antes cada página llamaba useRequireAuth por su cuenta). */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const ready = useRequireAuth();
  if (!ready) return null;

  return (
    <div className="flex flex-1">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
