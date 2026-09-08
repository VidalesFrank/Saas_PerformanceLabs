"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { api } from "@/lib/api";
import type { CatalogModule, CatalogProduct, User } from "@/lib/types";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Icon, moduleStats, moduleVisual } from "@/lib/module-visuals";

const PLAN_CFG: Record<string, { label: string; color: string; bg: string }> = {
  free:    { label: "Free",    color: "#0e7fa8", bg: "#0e7fa812" },
  pro:     { label: "Pro",     color: "#087f5b", bg: "#087f5b12" },
  premium: { label: "Premium", color: "#7c3aed", bg: "#7c3aed12" },
};

// ── Skeleton shimmer ──────────────────────────────────────────────────────────
function Sk({ w, h, className = "" }: { w?: number | string; h?: number; className?: string }) {
  return (
    <div className={`pl-skeleton ${className}`} style={{ width: w ?? "100%", height: h ?? 14 }} />
  );
}

// ── Hero section (compacta) ───────────────────────────────────────────────────
function Hero({ user, modules }: { user: User | null; modules: CatalogModule[] | null }) {
  const plan    = user?.plan ?? "free";
  const planCfg = PLAN_CFG[plan] ?? PLAN_CFG.free;
  const first   = user?.full_name?.split(" ")[0];

  const all      = modules?.flatMap(m => m.products) ?? [];
  const active   = all.filter(p => p.route).length;
  const inDev    = all.filter(p => p.estado === "en_desarrollo").length;
  const nModules = modules?.length ?? 0;

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface px-6 py-4 animate-[pl-fade-up_0.4s_ease-out_both]">
      <div>
        <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[.1em] text-text-muted">Bienvenido</div>
        <div className="flex items-center gap-2.5">
          {user
            ? <h1 className="text-[19px] font-semibold text-text">{first ?? "Frank"}</h1>
            : <Sk w={140} h={22} />
          }
          {user ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1"
              style={{ borderColor: `${planCfg.color}40`, background: planCfg.bg }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: planCfg.color }} />
              <span className="text-[11px] font-bold" style={{ color: planCfg.color }}>{planCfg.label}</span>
            </span>
          ) : <Sk w={60} h={22} />}
        </div>
      </div>

      <div className="flex gap-2.5">
        {([[nModules, "Módulos"], [active, "Herramientas activas"], [inDev, "En desarrollo"]] as [number, string][]).map(([val, label]) => (
          <div key={label} className="min-w-[88px] rounded-lg bg-surface-2 px-4 py-2 text-center">
            {modules
              ? <div className="font-mono text-lg font-bold text-text">{val}</div>
              : <Sk w={30} h={20} className="mx-auto mb-1" />
            }
            <div className="mt-0.5 text-[10px] text-text-muted">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Filtro / búsqueda ─────────────────────────────────────────────────────────
type FilterMode = "disponibles" | "en_desarrollo" | "roadmap";

const FILTER_LABEL: Record<FilterMode, string> = {
  disponibles: "Disponibles",
  en_desarrollo: "En desarrollo",
  roadmap: "Roadmap completo",
};

function FilterBar({
  mode, onModeChange, search, onSearchChange,
}: {
  mode: FilterMode; onModeChange: (m: FilterMode) => void;
  search: string; onSearchChange: (s: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex gap-0.5 rounded-lg bg-surface-2 p-1">
        {(Object.keys(FILTER_LABEL) as FilterMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className="rounded-md px-4 py-1.5 text-[12.5px] font-medium transition-colors"
            style={mode === m
              ? { background: "var(--color-surface)", color: "var(--color-text)", boxShadow: "0 1px 3px rgba(0,0,0,.08)", fontWeight: 600 }
              : { color: "var(--color-text-muted)" }}
          >
            {FILTER_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="relative w-[260px]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar módulo o herramienta…"
          className="w-full rounded-md border border-border bg-surface-2 py-2 pl-9 pr-3 text-[12.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}

// ── Tarjeta de producto ───────────────────────────────────────────────────────
const ESTADO_LABEL: Record<string, string> = {
  listo: "Disponible", en_desarrollo: "En desarrollo", idea: "Planificado",
};
const ESTADO_COLOR: Record<string, string> = {
  listo: "#087f5b", en_desarrollo: "#b45309", idea: "#6b7280",
};
const NIVEL_LABEL: Record<string, string> = {
  free: "Free", pro: "Pro", premium: "Premium",
};

function ProductCard({ product, color, delay }: { product: CatalogProduct; color: string; delay: number }) {
  const [hov, setHov] = useState(false);
  const active = !!product.route;

  const card = (
    <div
      onMouseEnter={() => active && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        animation: `pl-fade-up 0.35s ease-out ${delay}ms both`,
        borderRadius: 12,
        padding: "20px 20px 16px",
        display: "flex", flexDirection: "column", gap: 12,
        height: "100%",
        cursor: active ? "pointer" : "default",
        transition: "transform 0.18s ease, box-shadow 0.18s ease",
        ...(active ? {
          background: "var(--color-surface)",
          borderTop:    "1px solid var(--color-border)",
          borderRight:  "1px solid var(--color-border)",
          borderBottom: "1px solid var(--color-border)",
          borderLeft:   `3px solid ${color}`,
          boxShadow: hov ? `0 8px 24px ${color}1a, 0 2px 8px rgba(0,0,0,.06)` : "0 1px 4px rgba(0,0,0,.04)",
          transform: hov ? "translateY(-3px)" : "translateY(0)",
        } : {
          background: "var(--color-surface)",
          border: "1px dashed var(--color-border)",
          opacity: 0.55,
        }),
      }}
    >
      <Icon id={product.id} color={active ? color : "var(--color-text-muted)"} size={22} />

      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, color: "var(--color-text)", flex: 1 }}>
        {product.name}
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
        {product.nivel && (
          <span style={{
            fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:50,
            letterSpacing:".05em",
            background: active ? `${color}14` : "var(--color-surface-2)",
            color:      active ? color : "var(--color-text-muted)",
            border:     `1px solid ${active ? color + "35" : "var(--color-border)"}`,
          }}>
            {NIVEL_LABEL[product.nivel] ?? product.nivel}
          </span>
        )}
        <span style={{
          fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:50,
          background: `${ESTADO_COLOR[product.estado] ?? "#6b7280"}14`,
          color:      ESTADO_COLOR[product.estado] ?? "#6b7280",
          border:     `1px solid ${(ESTADO_COLOR[product.estado] ?? "#6b7280") + "30"}`,
        }}>
          {ESTADO_LABEL[product.estado] ?? product.estado}
        </span>

        {active && (
          <span style={{
            marginLeft:"auto", fontSize:18,
            color: hov ? color : "var(--color-border)",
            transition: "color 0.18s ease, transform 0.18s ease",
            transform: hov ? "translateX(4px)" : "translateX(0)",
            display: "inline-block",
          }}>→</span>
        )}
      </div>
    </div>
  );

  return active
    ? <Link href={product.route!} style={{ display:"block", height:"100%" }}>{card}</Link>
    : card;
}

// ── Sección de módulo ─────────────────────────────────────────────────────────
function ModuleSection({ mod, visibleProducts, index }: { mod: CatalogModule; visibleProducts: CatalogProduct[]; index: number }) {
  const visual = moduleVisual(mod.id, index);
  const stats = moduleStats(mod);
  const pct = Math.round((stats.done / stats.total) * 100);

  return (
    <section id={mod.id} style={{ animation: `pl-fade-up 0.4s ease-out ${index * 55}ms both`, scrollMarginTop: 24 }}>
      {/* Cabecera */}
      <div style={{ position:"relative", marginBottom:20, paddingLeft:16, borderLeft:`3px solid ${visual.color}`, overflow:"hidden" }}>
        <div style={{
          position:"absolute", right:0, top:"50%", transform:"translateY(-50%)",
          fontSize:84, fontWeight:900, lineHeight:1,
          color:`${visual.color}09`, userSelect:"none",
          fontFamily:"var(--font-jetbrains-mono)",
        }}>
          {String(index + 1).padStart(2, "0")}
        </div>

        <div style={{ position:"relative" }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:12, flexWrap:"wrap" }}>
            <h2 style={{ fontSize:15, fontWeight:700, color:"var(--color-text)", letterSpacing:"-.01em" }}>
              {mod.name}
            </h2>
            <span style={{ fontSize:11, fontWeight:600, color:visual.color }}>
              {stats.done}/{stats.total} disponibles
            </span>
          </div>

          <p style={{ fontSize:12, color:"var(--color-text-muted)", margin:"3px 0 10px" }}>
            {visual.desc}
          </p>

          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:180, height:4, background:"var(--color-surface-2)", borderRadius:4, overflow:"hidden" }}>
              <div style={{
                height:"100%", width:`${pct}%`,
                background: pct > 0 ? visual.color : "var(--color-border)",
                borderRadius:4, transition:"width 0.7s ease",
              }} />
            </div>
            <span style={{ fontSize:10, fontWeight:600, color:"var(--color-text-muted)" }}>
              {pct}%
            </span>
          </div>
        </div>
      </div>

      {/* Grid de tarjetas filtradas */}
      {visibleProducts.length === 0 ? (
        <p className="text-xs text-text-muted">Ningún producto coincide con el filtro actual.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleProducts.map((p, pi) => (
            <ProductCard key={p.id} product={p} color={visual.color} delay={index * 55 + pi * 35} />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Skeleton de carga ─────────────────────────────────────────────────────────
function CatalogSkeleton() {
  return (
    <div className="flex flex-col gap-12">
      {[8, 6, 3].map((n, mi) => (
        <div key={mi}>
          <div style={{ paddingLeft:16, borderLeft:"3px solid var(--color-border)", marginBottom:20 }}>
            <Sk w={260} h={18} className="mb-2" />
            <Sk w={400} h={12} className="mb-2" />
            <Sk w={140} h={5} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className="pl-skeleton" style={{ height:116, borderRadius:12, opacity: Math.max(0.2, 1 - i * 0.07) }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const ready = useRequireAuth();
  const [modules, setModules] = useState<CatalogModule[] | null>(null);
  const [user,    setUser]    = useState<User | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>("disponibles");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!ready) return;
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
    api.get<User>("/api/v1/auth/me").then(setUser).catch(() => {});
  }, [ready]);

  const filteredModules = useMemo(() => {
    if (!modules) return null;
    const term = search.trim().toLowerCase();
    return modules.map((mod) => ({
      mod,
      visibleProducts: mod.products.filter((p) => {
        if (filterMode === "disponibles" && !p.route) return false;
        if (filterMode === "en_desarrollo" && p.estado !== "en_desarrollo") return false;
        if (term && !p.name.toLowerCase().includes(term)) return false;
        return true;
      }),
    })).filter(({ visibleProducts }) => visibleProducts.length > 0);
  }, [modules, filterMode, search]);

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Dashboard" />
      <main className="flex-1 px-8 py-6">
        <Hero user={user} modules={modules} />

        {!modules ? (
          <CatalogSkeleton />
        ) : modules.length === 0 ? (
          <p className="text-sm text-text-muted">No se pudo cargar el catálogo.</p>
        ) : (
          <>
            <FilterBar mode={filterMode} onModeChange={setFilterMode} search={search} onSearchChange={setSearch} />
            {filteredModules && filteredModules.length === 0 ? (
              <p className="text-sm text-text-muted">Ningún módulo coincide con el filtro actual.</p>
            ) : (
              <div className="flex flex-col gap-12">
                {filteredModules?.map(({ mod, visibleProducts }, i) => (
                  <ModuleSection key={mod.id} mod={mod} visibleProducts={visibleProducts} index={i} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
