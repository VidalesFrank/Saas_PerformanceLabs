"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { clearToken } from "@/lib/auth";

/** Barra superior de cada herramienta. El logo ya vive en el Sidebar persistente
 * (ver src/components/sidebar.tsx) — aquí solo va el breadcrumb y las acciones. */
export function AppHeader({ crumb }: { crumb?: string }) {
  const router = useRouter();

  function logout() {
    clearToken();
    router.push("/login");
  }

  return (
    <header className="border-b border-border">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="font-mono text-sm text-text-muted">{crumb}</div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Button variant="ghost" onClick={logout}>
            Cerrar sesion
          </Button>
        </div>
      </div>
    </header>
  );
}
