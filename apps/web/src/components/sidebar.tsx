"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CatalogModule } from "@/lib/types";
import { ModuleIcon, moduleStats, moduleVisual } from "@/lib/module-visuals";

const COLLAPSE_KEY = "pl-sidebar-collapsed";

interface NavModule {
  id: string;
  label: string;
  color: string;
  icon: string;
  active: boolean;
  badgeText: string;
}

export function Sidebar() {
  const pathname = usePathname();
  const [modules, setModules] = useState<CatalogModule[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
  }, []);

  // Preferencia de colapso persistida por navegador — cada usuario ajusta el suyo.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* localStorage no disponible (SSR/privado) — se queda expandido */
    }
    setHydrated(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* noop */
      }
      return next;
    });
  }

  const isOverviewActive = pathname === "/dashboard";

  const navModules: NavModule[] = (modules ?? []).map((mod, i) => {
    const visual = moduleVisual(mod.id, i);
    const stats = moduleStats(mod);
    const active = visual.routePrefixes.some((prefix) => pathname?.startsWith(prefix));
    return {
      id: mod.id,
      label: mod.name.replace(/^Módulo \d+\s*-\s*/, "").replace(/^Modulo \d+\s*-\s*/, ""),
      color: visual.color,
      icon: visual.icon,
      active,
      badgeText: `${stats.done}/${stats.total}`,
    };
  });

  const width = collapsed ? 76 : 260;

  return (
    <div
      className="flex h-full flex-shrink-0 flex-col border-r border-border bg-surface"
      style={{ width, transition: hydrated ? "width 0.15s ease" : undefined }}
    >
      <div className="flex h-16 flex-shrink-0 items-center border-b border-border px-5">
        {collapsed ? (
          <span className="font-mono text-sm font-extrabold text-accent">PL</span>
        ) : (
          <Link href="/dashboard" className="whitespace-nowrap font-mono text-sm font-bold tracking-wide">
            <span className="text-accent">PERFORMANCE</span>
            <span className="text-text">LABS</span>
          </Link>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pt-3">
        <SidebarRow
          href="/dashboard"
          label="Resumen"
          icon="home"
          color="#0e7fa8"
          active={isOverviewActive}
          collapsed={collapsed}
        />

        {!collapsed && (
          <div className="mb-1 mt-4 px-5 text-[10px] font-bold uppercase tracking-[.12em] text-text-muted">
            Módulos
          </div>
        )}
        {collapsed && <div className="mt-3" />}

        {navModules.map((m) => (
          <SidebarRow
            key={m.id}
            href={`/dashboard#${m.id}`}
            label={m.label}
            icon={m.icon}
            color={m.color}
            active={m.active}
            collapsed={collapsed}
            badgeText={m.badgeText}
          />
        ))}
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border p-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-muted hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={collapsed ? "M9 18l6-6-6-6" : "M15 18l-6-6 6-6"} />
          </svg>
        </button>
        {!collapsed && <span className="text-xs font-medium text-text-muted">Colapsar</span>}
      </div>
    </div>
  );
}

function SidebarRow({
  href, label, icon, color, active, collapsed, badgeText,
}: {
  href: string; label: string; icon: string; color: string;
  active: boolean; collapsed: boolean; badgeText?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Link
      href={href}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative mx-2 mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5"
      style={{
        justifyContent: collapsed ? "center" : "flex-start",
        background: active ? `${color}14` : "transparent",
        borderLeft: active ? `3px solid ${color}` : "3px solid transparent",
      }}
    >
      <ModuleIcon type={icon} color={active ? color : "var(--color-text-muted)"} size={18} />
      {!collapsed && (
        <span
          className="flex-1 truncate text-[13px] font-semibold"
          style={{ color: active ? color : "var(--color-text-muted)" }}
        >
          {label}
        </span>
      )}
      {!collapsed && badgeText && (
        <span
          className="flex-shrink-0 rounded-full border px-[7px] py-[1px] font-mono text-[10px] font-bold"
          style={{
            background: active ? `${color}14` : "transparent",
            color: active ? color : "var(--color-text-muted)",
            borderColor: active ? `${color}40` : "var(--color-border)",
          }}
        >
          {badgeText}
        </span>
      )}
      {collapsed && hovered && (
        <span className="pointer-events-none absolute left-14 top-2 z-10 whitespace-nowrap rounded-md bg-text px-2.5 py-1.5 text-[11px] font-semibold text-bg shadow-lg">
          {label}{badgeText ? ` · ${badgeText}` : ""}
        </span>
      )}
    </Link>
  );
}
