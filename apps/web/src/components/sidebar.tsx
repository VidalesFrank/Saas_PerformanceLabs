"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CatalogModule } from "@/lib/types";
import { COLOR_TOKENS, ModuleIcon, moduleStats, moduleVisual } from "@/lib/module-visuals";
import { useTheme } from "@/lib/theme";

const COLLAPSE_KEY = "pl-sidebar-collapsed";

interface NavModule {
  id: string;
  label: string;
  gradient: string;
  accent: string;
  icon: string;
  active: boolean;
  badgeText: string;
}

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggle: toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const [modules, setModules] = useState<CatalogModule[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
  }, []);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* noop */
    }
    setHydrated(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  }

  const isOverviewActive = pathname === "/dashboard";
  const isCatalogActive  = pathname?.startsWith("/catalog/colombia-2026-08-10") ?? false;

  const navModules: NavModule[] = (modules ?? []).map((mod, i) => {
    const visual = moduleVisual(mod.id, i);
    const stats = moduleStats(mod);
    const active = visual.routePrefixes.some((prefix) => pathname?.startsWith(prefix));
    return {
      id: mod.id,
      label: mod.name,
      gradient: visual.gradient,
      accent: visual.accent,
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
      {/* ── Logo ────────────────────────────────────────────────────────── */}
      <div className="flex h-16 flex-shrink-0 items-center border-b border-border px-5">
        {collapsed ? (
          <Link href="/dashboard" className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)" }}>
            <span className="font-mono text-[11px] font-extrabold text-[#050b18]">PL</span>
          </Link>
        ) : (
          <Link href="/dashboard" className="flex items-center gap-2 whitespace-nowrap">
            <span className="flex h-7 w-7 items-center justify-center rounded-md"
              style={{ background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)" }}>
              <span className="font-mono text-[10px] font-extrabold text-[#050b18]">PL</span>
            </span>
            <span className="font-mono text-[13px] font-bold tracking-wider">
              <span style={{
                background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}>PERFORMANCE</span>
              <span className="text-text">LABS</span>
            </span>
          </Link>
        )}
      </div>

      {/* ── Navegación ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto pt-3">
        <SidebarRow
          href="/dashboard"
          label="Resumen"
          icon="home"
          gradient="linear-gradient(135deg, #64748b 0%, #475569 100%)"
          accent="#64748b"
          active={isOverviewActive}
          collapsed={collapsed}
        />

        <SidebarRow
          href="/catalog/colombia-2026-08-10"
          label="Catálogo · Colombia 10-ago-2026"
          icon="seismograph"
          gradient={COLOR_TOKENS.amber.gradient}
          accent={COLOR_TOKENS.amber.accent}
          active={isCatalogActive}
          collapsed={collapsed}
        />

        {!collapsed && (
          <div className="mb-1 mt-4 px-5 text-[10px] font-bold uppercase tracking-[.14em] text-text-muted">
            Flujos
          </div>
        )}
        {collapsed && <div className="mt-3" />}

        {navModules.map((m) => (
          <SidebarRow
            key={m.id}
            href={`/dashboard#${m.id}`}
            label={m.label}
            icon={m.icon}
            gradient={m.gradient}
            accent={m.accent}
            active={m.active}
            collapsed={collapsed}
            badgeText={m.badgeText}
          />
        ))}
      </div>

      {/* ── Toggle tema (claro/oscuro) ──────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border p-3">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          title={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-muted hover:text-text hover:border-[color-mix(in_srgb,var(--tech-cyan)_45%,var(--color-border))] transition-colors"
        >
          {isDark ? (
            /* Sol — ir a modo claro */
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4"/>
              <line x1="12" y1="2" x2="12" y2="4"/>
              <line x1="12" y1="20" x2="12" y2="22"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="2" y1="12" x2="4" y2="12"/>
              <line x1="20" y1="12" x2="22" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            /* Luna — ir a modo oscuro */
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>
        {!collapsed && (
          <span className="text-xs font-medium text-text-muted">
            {isDark ? "Tema claro" : "Tema oscuro"}
          </span>
        )}
      </div>

      {/* ── Toggle colapsar ─────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border p-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-muted hover:text-text hover:border-[color-mix(in_srgb,var(--tech-cyan)_45%,var(--color-border))] transition-colors"
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
  href, label, icon, gradient, accent, active, collapsed, badgeText,
}: {
  href: string;
  label: string;
  icon: string;
  gradient: string;
  accent: string;
  active: boolean;
  collapsed: boolean;
  badgeText?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Link
      href={href}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative mx-2 mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors"
      style={{
        justifyContent: collapsed ? "center" : "flex-start",
        background: active
          ? `color-mix(in srgb, ${accent} 12%, transparent)`
          : hovered ? "var(--color-surface-2)" : "transparent",
        borderLeft: active ? `3px solid ${accent}` : "3px solid transparent",
      }}
    >
      {active ? (
        <div
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
          style={{ background: gradient, boxShadow: `0 6px 16px -8px ${accent}80` }}
        >
          <ModuleIcon type={icon} color="#050b18" size={15} strokeWidth={2.2} />
        </div>
      ) : (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
          <ModuleIcon type={icon} color={hovered ? accent : "var(--color-text-muted)"} size={17} strokeWidth={1.75} />
        </div>
      )}

      {!collapsed && (
        <span
          className="flex-1 truncate text-[13px] font-semibold"
          style={{ color: active ? "var(--color-text)" : hovered ? "var(--color-text)" : "var(--color-text-muted)" }}
        >
          {label}
        </span>
      )}

      {!collapsed && badgeText && (
        <span
          className="flex-shrink-0 rounded-full border px-[7px] py-[1px] font-mono text-[10px] font-bold"
          style={{
            background: active ? `color-mix(in srgb, ${accent} 14%, transparent)` : "transparent",
            color: active ? accent : "var(--color-text-muted)",
            borderColor: active ? `color-mix(in srgb, ${accent} 40%, transparent)` : "var(--color-border)",
          }}
        >
          {badgeText}
        </span>
      )}

      {collapsed && hovered && (
        <span className="pointer-events-none absolute left-14 top-2 z-10 whitespace-nowrap rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-text shadow-lg">
          {label}{badgeText ? ` · ${badgeText}` : ""}
        </span>
      )}
    </Link>
  );
}
