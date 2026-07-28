"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { api } from "@/lib/api";
import type { CatalogModule, CatalogProduct, User } from "@/lib/types";
import { useRequireAuth } from "@/lib/use-require-auth";

// ── Identidad visual por módulo ───────────────────────────────────────────────
const MODULE_CFG = [
  { color: "#0e7fa8", desc: "Interoperabilidad con software comercial y construcción del modelo OpenSees" },
  { color: "#087f5b", desc: "Análisis de secciones de concreto reforzado con modelos de confinamiento" },
  { color: "#7c3aed", desc: "Análisis no lineal: modal, pushover, dinámico e IDA sobre edificios reales" },
  { color: "#d97706", desc: "Evaluación del desempeño sísmico y curvas de fragilidad estructural" },
  { color: "#dc2626", desc: "Probabilidad de colapso, vulnerabilidad y pérdidas económicas esperadas" },
  { color: "#0f766e", desc: "Reportes automáticos de desempeño y recomendaciones de intervención" },
];

const PLAN_CFG: Record<string, { label: string; color: string; bg: string }> = {
  free:    { label: "Free",    color: "#0e7fa8", bg: "#0e7fa812" },
  pro:     { label: "Pro",     color: "#087f5b", bg: "#087f5b12" },
  premium: { label: "Premium", color: "#7c3aed", bg: "#7c3aed12" },
};

// ── Iconos SVG por tipo de producto ──────────────────────────────────────────
const ICON_D: Record<string, string> = {
  wave:       "M2 12C4 8 6 8 8 12s4 8 6 4 4-8 6-4",
  section:    "M4 4h16v16H4zM4 9h16M4 14h16M9 4v16M14 4v16",
  curve:      "M3 20h4V13c0-3 3-5 5-5s3 2 3 4-1 4-1 8h7",
  building:   "M3 21h18M3 7l9-4 9 4M4 21V7M20 21V7M9 21v-4h6v4",
  seismograph:"M2 12h4l2-7 3 14 3-10 2 3h6",
  gauge:      "M5.6 17.4A8 8 0 1 1 18.4 17.4M12 12l4-5",
  fragility:  "M3 19c3 0 4-14 7-14s3 9 5 9 3-5 6-5",
  risk:       "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 8v4M12 16h.01",
  report:     "M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  import:     "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  settings:   "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  tool:       "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  column:     "M7 3h10v18H7zM7 8h10M7 13h10",
  calc:       "M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM8 6h8M8 10h3M13 10h3M8 14h3M13 14h3M8 18h8",
  default:    "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 8v4M12 16h.01",
};

function iconTypeFor(id: string): string {
  if (/import|conv/.test(id))                       return "import";
  if (/espectro/.test(id))                           return "wave";
  if (/interaccion|diagrama/.test(id))               return "section";
  if (/curvatura|fibra/.test(id))                    return "curve";
  if (/edificio/.test(id))                           return "building";
  if (/registro|ciclico/.test(id))                   return "seismograph";
  if (/desempeno|calculo-r|param|r-dif/.test(id))    return "gauge";
  if (/fragilidad|vulnerabilidad|colapso/.test(id))  return "fragility";
  if (/perdida|recuperacion|riesgo/.test(id))        return "risk";
  if (/reporte/.test(id))                            return "report";
  if (/gestion|editor/.test(id))                     return "settings";
  if (/axial|confinamiento/.test(id))                return "column";
  if (/conexion|acero|biblioteca/.test(id))          return "tool";
  if (/calculadora/.test(id))                        return "calc";
  return "default";
}

function Icon({ id, color, size = 20 }: { id: string; color: string; size?: number }) {
  const d = ICON_D[iconTypeFor(id)] ?? ICON_D.default;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// ── Skeleton shimmer ──────────────────────────────────────────────────────────
function Sk({ w, h, className = "" }: { w?: number | string; h?: number; className?: string }) {
  return (
    <div className={`pl-skeleton ${className}`} style={{ width: w ?? "100%", height: h ?? 14 }} />
  );
}

// ── Hero section ──────────────────────────────────────────────────────────────
function Hero({ user, modules }: { user: User | null; modules: CatalogModule[] | null }) {
  const plan    = user?.plan ?? "free";
  const planCfg = PLAN_CFG[plan] ?? PLAN_CFG.free;
  const first   = user?.full_name?.split(" ")[0];

  const all      = modules?.flatMap(m => m.products) ?? [];
  const active   = all.filter(p => p.route).length;
  const inDev    = all.filter(p => p.estado === "en_desarrollo").length;
  const nModules = modules?.length ?? 0;

  return (
    <div style={{
      background: "linear-gradient(135deg, var(--color-surface) 0%, #0e7fa808 60%, #7c3aed05 100%)",
      border: "1px solid var(--color-border)",
      borderRadius: 16,
      padding: "32px 36px",
      marginBottom: 44,
      position: "relative",
      overflow: "hidden",
      animation: "pl-fade-up 0.4s ease-out both",
    }}>
      {/* círculos decorativos */}
      <div style={{ position:"absolute", right:-30, top:-40, width:240, height:240, borderRadius:"50%", background:"radial-gradient(circle, #0e7fa80d 0%, transparent 70%)", pointerEvents:"none" }} />
      <div style={{ position:"absolute", right:100, bottom:-70, width:180, height:180, borderRadius:"50%", background:"radial-gradient(circle, #7c3aed08 0%, transparent 70%)", pointerEvents:"none" }} />

      <div style={{ position:"relative" }} className="flex flex-col gap-5">
        {/* Saludo + badge de plan */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[.15em] text-text-muted">PerformanceLabs</span>
              <span style={{ width:3, height:3, borderRadius:"50%", background:"var(--color-border)", display:"inline-block" }} />
              <span className="text-[11px] text-text-muted">Plataforma de ingeniería sísmica</span>
            </div>
            {user
              ? <h1 className="text-2xl font-semibold text-text">Bienvenido{first ? `, ${first}` : ""}</h1>
              : <Sk w={200} h={28} className="mt-1" />
            }
          </div>

          {user ? (
            <div style={{
              display:"inline-flex", alignItems:"center", gap:7,
              padding:"6px 14px", borderRadius:50,
              border:`1.5px solid ${planCfg.color}40`,
              background: planCfg.bg,
            }}>
              <span style={{ width:7, height:7, borderRadius:"50%", background:planCfg.color, boxShadow:`0 0 6px ${planCfg.color}80` }} />
              <span style={{ fontSize:12, fontWeight:700, color:planCfg.color, letterSpacing:".04em" }}>
                {planCfg.label}
              </span>
            </div>
          ) : <Sk w={80} h={30} />}
        </div>

        {/* Stats */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3, auto)", gap:10, width:"fit-content" }}>
          {([
            [nModules,  "Módulos"],
            [active,    "Herramientas activas"],
            [inDev,     "En desarrollo"],
          ] as [number, string][]).map(([val, label]) => (
            <div key={label} style={{
              background:"var(--color-surface)", border:"1px solid var(--color-border)",
              borderRadius:10, padding:"12px 20px", minWidth:110,
            }}>
              {modules
                ? <div className="font-mono text-2xl font-bold text-text">{val}</div>
                : <Sk w={40} h={28} className="mb-1" />
              }
              <div style={{ fontSize:11, color:"var(--color-text-muted)", marginTop:2 }}>{label}</div>
            </div>
          ))}
        </div>
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
function ModuleSection({ mod, index }: { mod: CatalogModule; index: number }) {
  const cfg      = MODULE_CFG[index] ?? MODULE_CFG[0];
  const available = mod.products.filter(p => p.route).length;
  const total     = mod.products.length;
  const pct       = Math.round((available / total) * 100);

  return (
    <section style={{ animation: `pl-fade-up 0.4s ease-out ${index * 55}ms both` }}>
      {/* Cabecera */}
      <div style={{ position:"relative", marginBottom:20, paddingLeft:16, borderLeft:`3px solid ${cfg.color}`, overflow:"hidden" }}>
        <div style={{
          position:"absolute", right:0, top:"50%", transform:"translateY(-50%)",
          fontSize:84, fontWeight:900, lineHeight:1,
          color:`${cfg.color}09`, userSelect:"none",
          fontFamily:"var(--font-jetbrains-mono)",
        }}>
          {String(index + 1).padStart(2, "0")}
        </div>

        <div style={{ position:"relative" }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:12, flexWrap:"wrap" }}>
            <h2 style={{ fontSize:15, fontWeight:700, color:"var(--color-text)", letterSpacing:"-.01em" }}>
              {mod.name}
            </h2>
            <span style={{ fontSize:11, fontWeight:600, color:cfg.color }}>
              {available}/{total} disponibles
            </span>
          </div>

          <p style={{ fontSize:12, color:"var(--color-text-muted)", margin:"3px 0 10px" }}>
            {cfg.desc}
          </p>

          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:180, height:4, background:"var(--color-surface-2)", borderRadius:4, overflow:"hidden" }}>
              <div style={{
                height:"100%", width:`${pct}%`,
                background: pct > 0 ? cfg.color : "var(--color-border)",
                borderRadius:4, transition:"width 0.7s ease",
              }} />
            </div>
            <span style={{ fontSize:10, fontWeight:600, color:"var(--color-text-muted)" }}>
              {pct}%
            </span>
          </div>
        </div>
      </div>

      {/* Grid de tarjetas */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {mod.products.map((p, pi) => (
          <ProductCard key={p.id} product={p} color={cfg.color} delay={index * 55 + pi * 35} />
        ))}
      </div>
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

  useEffect(() => {
    if (!ready) return;
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
    api.get<User>("/api/v1/auth/me").then(setUser).catch(() => {});
  }, [ready]);

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Dashboard" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Hero user={user} modules={modules} />

        {!modules ? (
          <CatalogSkeleton />
        ) : modules.length === 0 ? (
          <p className="text-sm text-text-muted">No se pudo cargar el catálogo.</p>
        ) : (
          <div className="flex flex-col gap-12">
            {modules.map((mod, i) => (
              <ModuleSection key={mod.id} mod={mod} index={i} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
