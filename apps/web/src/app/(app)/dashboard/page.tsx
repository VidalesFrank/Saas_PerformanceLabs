"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { HeroShowcase3D } from "@/components/dashboard/HeroShowcase3D";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Icon, ModuleIcon, moduleVisual } from "@/lib/module-visuals";
import type { CatalogModule, CatalogProduct, User } from "@/lib/types";

/* ──────────────────────────────────────────────────────────────────────────
   Dashboard — hero dark + grupos de flujo + roadmap colapsable.
   ────────────────────────────────────────────────────────────────────────── */

const PLAN_CFG: Record<string, { label: string; dot: string; text: string }> = {
  free:    { label: "Free",    dot: "#38bdf8", text: "#7dd3fc" },
  pro:     { label: "Pro",     dot: "#34d399", text: "#6ee7b7" },
  premium: { label: "Premium", dot: "#c084fc", text: "#d8b4fe" },
};

const ESTADO_LABEL: Record<string, string> = {
  listo: "Disponible",
  en_desarrollo: "En desarrollo",
  idea: "Planificado",
};

const NIVEL_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

// ── Skeleton shimmer ─────────────────────────────────────────────────────────

function Sk({ w, h, className = "" }: { w?: number | string; h?: number; className?: string }) {
  return <div className={`pl-skeleton ${className}`} style={{ width: w ?? "100%", height: h ?? 14 }} />;
}

// ── Chips de meta (normativas / tecnologías) ─────────────────────────────────

function MetaChip({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <span className="pl-hero-chip">
      <span className="pl-hero-chip-icon">{icon}</span>
      {label}
    </span>
  );
}

// ── Atajo premium (3 tarjetas grandes bajo CTA) ──────────────────────────────

function ShortcutCard({
  product,
  grad,
  accent,
}: {
  product: CatalogProduct;
  grad: string;
  accent: string;
}) {
  if (!product.route) return null;
  return (
    <Link
      href={product.route}
      className="pl-shortcut-card"
      style={{ "--_accent-grad": grad } as React.CSSProperties}
    >
      <div className="flex items-start justify-between">
        <div className="pl-shortcut-icon" style={{ background: grad, boxShadow: `0 6px 18px -6px ${accent}66` }}>
          <Icon id={product.id} color="#050b18" size={22} strokeWidth={2} />
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{
            background: "rgba(34,211,238,0.10)",
            color: "#67e8f9",
            border: "1px solid rgba(34,211,238,0.28)",
          }}
        >
          Abrir →
        </span>
      </div>
      <div>
        <div className="text-[14.5px] font-semibold text-slate-100">{product.name}</div>
        {product.subtitle && (
          <div className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-slate-400">
            {product.subtitle}
          </div>
        )}
      </div>
    </Link>
  );
}

// ── Hero oscuro ──────────────────────────────────────────────────────────────

function Hero({
  user,
  modules,
  onLogout,
}: {
  user: User | null;
  modules: CatalogModule[] | null;
  onLogout: () => void;
}) {
  const plan    = user?.plan ?? "free";
  const planCfg = PLAN_CFG[plan] ?? PLAN_CFG.free;
  const first   = user?.full_name?.split(" ")[0];

  // Atajos destacados: productos con `featured: true` en catalog.py
  const featured = useMemo(() => {
    if (!modules) return [];
    const list: Array<{ product: CatalogProduct; grad: string; accent: string }> = [];
    for (const mod of modules) {
      const visual = moduleVisual(mod.id);
      for (const p of mod.products) {
        if (p.featured && p.route) {
          list.push({ product: p, grad: visual.gradient, accent: visual.accent });
        }
      }
    }
    return list.slice(0, 3);
  }, [modules]);

  // Links directos a módulos destacados (CTA principal + secundaria)
  const constructor = featured.find((f) => f.product.id === "constructor-modelos") ?? featured[0];
  const spectrum    = featured.find((f) => f.product.id === "espectros-nsr10") ?? featured[1];

  return (
    <section className="pl-hero-dark">
      {/* Controles superiores (theme + logout) flotando sobre el hero */}
      <div className="absolute right-6 top-5 z-10 flex items-center gap-2">
        <ThemeToggle />
        <button
          type="button"
          onClick={onLogout}
          className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/5"
          style={{ borderColor: "rgba(148, 163, 184, 0.25)" }}
        >
          Cerrar sesión
        </button>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-8 pb-12 pt-14 lg:grid-cols-[1.1fr_1fr] lg:gap-10 lg:pt-16">
        {/* ── Columna izquierda: pill + headline + subtexto + CTAs + chips ─── */}
        <div className="flex flex-col justify-center" style={{ animation: "pl-fade-up 0.5s ease-out both" }}>
          <div className="pl-hero-pill mb-5">
            <span className="pl-hero-pill-dot" />
            PerformanceLabs
            {user && (
              <>
                <span className="opacity-40">·</span>
                <span style={{ color: planCfg.text }}>{planCfg.label}</span>
              </>
            )}
          </div>

          <h1 className="pl-hero-headline text-[38px] md:text-[48px] lg:text-[52px]">
            Ingeniería estructural
            <br />
            <span className="pl-hero-gradient-text">de alto desempeño.</span>
          </h1>

          <p className="mt-5 max-w-xl text-[14.5px] leading-relaxed text-slate-300/90">
            {first ? `Bienvenido, ${first}. ` : ""}
            Plataforma OpenSees para análisis no lineal 3D, evaluación sísmica
            avanzada y toma de decisiones basadas en desempeño. NSR-10, ASCE 41 y FEMA integrados.
          </p>

          {/* CTAs */}
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {constructor?.product.route && (
              <Link href={constructor.product.route} className="pl-cta-primary">
                Abrir {constructor.product.name}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </Link>
            )}
            {spectrum?.product.route && (
              <Link href={spectrum.product.route} className="pl-cta-ghost">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12C4 8 6 8 8 12s4 8 6 4 4-8 6-4" />
                </svg>
                {spectrum.product.name}
              </Link>
            )}
          </div>

          {/* Chips de meta */}
          <div className="mt-6 flex flex-wrap items-center gap-5">
            <MetaChip
              label="OpenSees · OpenSeesPy"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              }
            />
            <MetaChip
              label="NSR-10 · ASCE 41 · FEMA"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetaChip
              label="Análisis no lineal 3D"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18M3 7l9-4 9 4M4 21V7M20 21V7M9 21v-4h6v4" />
                </svg>
              }
            />
          </div>
        </div>

        {/* ── Columna derecha: wireframe 3D vivo ─────────────────────────── */}
        <div
          className="relative flex items-center justify-center"
          style={{ animation: "pl-fade-up 0.6s 0.1s ease-out both" }}
        >
          <div className="w-full">
            {modules ? (
              <HeroShowcase3D height={440} />
            ) : (
              <div
                className="w-full rounded-xl"
                style={{ height: 440, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(148,163,184,0.1)" }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Atajos premium (3 cards bajo el hero) ─────────────────────────── */}
      <div className="mx-auto max-w-7xl px-8 pb-10">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-[.14em] text-cyan-400/80">Atajos</div>
            <div className="text-[13.5px] text-slate-400">Las herramientas que más usas</div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {modules === null ? (
            <>
              <Sk h={134} />
              <Sk h={134} />
              <Sk h={134} />
            </>
          ) : (
            featured.map(({ product, grad, accent }) => (
              <ShortcutCard key={product.id} product={product} grad={grad} accent={accent} />
            ))
          )}
        </div>
      </div>

      {/* ── Banda de stats ────────────────────────────────────────────────── */}
      <StatsBand modules={modules} />
    </section>
  );
}

// ── Banda de stats (parte inferior del hero) ─────────────────────────────────

function StatsBand({ modules }: { modules: CatalogModule[] | null }) {
  const all     = modules?.flatMap((m) => m.products) ?? [];
  const active  = all.filter((p) => p.route).length;
  const mods    = modules?.filter((m) => m.id !== "roadmap").length ?? 0;
  const inDev   = all.filter((p) => p.estado === "en_desarrollo").length;

  const items: [string, string, React.ReactNode][] = [
    [String(mods), "Flujos activos",
      <svg key="m" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>],
    [String(active), "Herramientas disponibles",
      <svg key="a" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>],
    [String(inDev), "En desarrollo",
      <svg key="d" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>],
    ["356", "Tests automatizados",
      <svg key="t" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"><path d="M9 11H3V3h6zM21 21h-6v-8h6zM15 11h6V3h-6zM3 21h6v-8H3z" /></svg>],
  ];

  const STAT_ACCENT = ["#22d3ee", "#3b82f6", "#f59e0b", "#8b5cf6"];
  return (
    <div className="border-t border-white/5 px-8 py-5" style={{ background: "rgba(5, 11, 24, 0.5)" }}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 md:justify-between">
        {items.map(([val, label, icon], i) => {
          const accent = STAT_ACCENT[i % STAT_ACCENT.length];
          return (
            <div
              key={label}
              className="pl-stat-chip"
              style={{ "--_stat-accent": accent } as React.CSSProperties}
            >
              <span style={{ color: accent }}>{icon}</span>
              {modules ? <span className="pl-stat-chip-num">{val}</span> : <Sk w={28} h={18} />}
              <span>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tabs de flujo ────────────────────────────────────────────────────────────

function GroupTabs({
  modules,
  active,
  onChange,
}: {
  modules: CatalogModule[];
  active: string;
  onChange: (id: string) => void;
}) {
  const nonRoadmap = modules.filter((m) => m.id !== "roadmap");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange("all")}
        className="pl-group-tab"
        data-active={active === "all"}
        style={{ "--_tab-grad": "linear-gradient(135deg, #22d3ee, #6366f1)" } as React.CSSProperties}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
        Todos los flujos
      </button>
      {nonRoadmap.map((mod) => {
        const visual = moduleVisual(mod.id);
        return (
          <button
            key={mod.id}
            type="button"
            onClick={() => onChange(mod.id)}
            className="pl-group-tab"
            data-active={active === mod.id}
            style={{ "--_tab-grad": visual.gradient } as React.CSSProperties}
          >
            <ModuleIcon type={visual.icon} color="currentColor" size={14} strokeWidth={2} />
            {mod.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Tarjeta de herramienta (grid de secciones) ───────────────────────────────

function ToolCard({
  product,
  accent,
  delay,
}: {
  product: CatalogProduct;
  accent: string;
  delay: number;
}) {
  const active = !!product.route;

  const body = (
    <div
      className="pl-tool-card"
      data-active={active}
      style={{
        "--_card-accent": accent,
        animation: `pl-fade-up 0.4s ${delay}ms ease-out both`,
      } as React.CSSProperties}
    >
      <div className="flex items-start justify-between">
        <div className="pl-tool-card-icon">
          <Icon id={product.id} color={active ? accent : "var(--color-text-muted)"} size={20} strokeWidth={2} />
        </div>
        {active && (
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        )}
      </div>

      <div className="flex-1">
        <div className="text-[14px] font-semibold leading-tight text-text">{product.name}</div>
        {product.subtitle && (
          <div className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">{product.subtitle}</div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {product.nivel && (
          <span
            className="rounded-full border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider"
            style={{
              background: active ? `color-mix(in srgb, ${accent} 12%, transparent)` : "var(--color-surface-2)",
              color: active ? accent : "var(--color-text-muted)",
              borderColor: active ? `color-mix(in srgb, ${accent} 35%, transparent)` : "var(--color-border)",
            }}
          >
            {NIVEL_LABEL[product.nivel] ?? product.nivel}
          </span>
        )}
        <span
          className="rounded-full border px-2 py-0.5 text-[9.5px] font-semibold"
          style={{
            background:   product.estado === "listo" ? "rgba(16, 185, 129, 0.10)"
                        : product.estado === "en_desarrollo" ? "rgba(245, 158, 11, 0.10)"
                        : "var(--color-surface-2)",
            color:        product.estado === "listo" ? "#059669"
                        : product.estado === "en_desarrollo" ? "#b45309"
                        : "var(--color-text-muted)",
            borderColor:  product.estado === "listo" ? "rgba(16, 185, 129, 0.30)"
                        : product.estado === "en_desarrollo" ? "rgba(245, 158, 11, 0.30)"
                        : "var(--color-border)",
          }}
        >
          {ESTADO_LABEL[product.estado] ?? product.estado}
        </span>
      </div>
    </div>
  );

  return active ? (
    <Link href={product.route!} className="block h-full">{body}</Link>
  ) : (
    <div className="h-full">{body}</div>
  );
}

// ── Sección de grupo (cabecera + cards) ──────────────────────────────────────

function GroupSection({
  mod,
  products,
  index,
}: {
  mod: CatalogModule;
  products: CatalogProduct[];
  index: number;
}) {
  const visual = moduleVisual(mod.id);
  const desc = mod.desc ?? visual.desc;

  return (
    <section
      id={mod.id}
      style={{ animation: `pl-fade-up 0.4s ${index * 60}ms ease-out both`, scrollMarginTop: 24 }}
    >
      <div className="mb-5 flex items-center gap-3">
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: visual.gradient, boxShadow: `0 8px 24px -10px ${visual.accent}80` }}
        >
          <ModuleIcon type={visual.icon} color="#050b18" size={18} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold leading-tight tracking-tight text-text">{mod.name}</h2>
          {desc && <p className="mt-0.5 text-[12px] text-text-muted">{desc}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p, i) => (
          <ToolCard key={p.id} product={p} accent={visual.accent} delay={index * 60 + i * 40} />
        ))}
      </div>
    </section>
  );
}

// ── Roadmap colapsable ───────────────────────────────────────────────────────

function RoadmapSection({ mod }: { mod: CatalogModule }) {
  const [open, setOpen] = useState(false);
  const visual = moduleVisual(mod.id);
  return (
    <section className="mt-14">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-xl border border-[var(--panel-muted)]/60 bg-[var(--color-surface)] px-5 py-4 text-left transition-colors hover:bg-[var(--panel-muted)]/40 hover:border-[var(--color-accent)]/40"
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: visual.gradient, boxShadow: `0 6px 20px -10px ${visual.accent}70` }}
          >
            <ModuleIcon type={visual.icon} color="#050b18" size={16} strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-[13.5px] font-semibold text-text">{mod.name}</div>
            <div className="text-[11.5px] text-text-muted">
              {mod.desc ?? visual.desc} · {mod.products.length} módulos planificados
            </div>
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
          style={{ transition: "transform 0.18s ease", transform: open ? "rotate(180deg)" : "rotate(0)", color: "var(--color-text-muted)" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          style={{ animation: "pl-fade-up 0.3s ease-out both" }}
        >
          {mod.products.map((p, i) => (
            <ToolCard key={p.id} product={p} accent={visual.accent} delay={i * 35} />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [modules, setModules] = useState<CatalogModule[] | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>("all");
  const [search, setSearch] = useState("");
  const toolsAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
    api.get<User>("/api/v1/auth/me").then(setUser).catch(() => {});
  }, []);

  function logout() {
    clearToken();
    router.push("/login");
  }

  const roadmap = modules?.find((m) => m.id === "roadmap") ?? null;
  const nonRoadmap = modules?.filter((m) => m.id !== "roadmap") ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return nonRoadmap
      .filter((m) => activeGroup === "all" || m.id === activeGroup)
      .map((m) => ({
        mod: m,
        products: m.products.filter((p) => !term || p.name.toLowerCase().includes(term) || (p.subtitle ?? "").toLowerCase().includes(term)),
      }))
      .filter(({ products }) => products.length > 0);
  }, [nonRoadmap, activeGroup, search]);

  return (
    <div className="flex flex-1 flex-col">
      <Hero user={user} modules={modules} onLogout={logout} />

      <main className="flex-1 px-6 py-10 md:px-8">
        <div ref={toolsAnchorRef} className="mx-auto max-w-7xl">
          {/* Tabs de flujo + buscador */}
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            {modules ? (
              <GroupTabs modules={modules} active={activeGroup} onChange={setActiveGroup} />
            ) : (
              <Sk w={520} h={38} />
            )}
            <div className="relative w-[260px]">
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar herramienta…"
                className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-[12.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Contenido: stack de grupos o grupo único */}
          {!modules ? (
            <div className="flex flex-col gap-10">
              {[1, 2, 3].map((i) => (
                <div key={i}>
                  <Sk w={300} h={20} className="mb-4" />
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[1, 2, 3].map((j) => (
                      <Sk key={j} h={160} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-20 text-center text-sm text-text-muted">
              Ninguna herramienta coincide con la búsqueda actual.
            </p>
          ) : (
            <div className="flex flex-col gap-14">
              {filtered.map(({ mod, products }, i) => (
                <GroupSection key={mod.id} mod={mod} products={products} index={i} />
              ))}
            </div>
          )}

          {/* Roadmap colapsable */}
          {roadmap && <RoadmapSection mod={roadmap} />}
        </div>
      </main>
    </div>
  );
}
