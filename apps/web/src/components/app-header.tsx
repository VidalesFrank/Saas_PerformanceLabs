"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { clearToken } from "@/lib/auth";

export function AppHeader({ crumb }: { crumb?: string }) {
  const router = useRouter();

  function logout() {
    clearToken();
    router.push("/login");
  }

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3 font-mono text-sm">
          <Link href="/dashboard" className="font-semibold tracking-widest text-accent">
            PERFORMANCE<span className="text-text">LABS</span>
          </Link>
          {crumb && (
            <>
              <span className="text-text-muted">/</span>
              <span className="text-text-muted">{crumb}</span>
            </>
          )}
        </div>
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
