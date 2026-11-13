// ── Identidad visual de los grupos/módulos del catálogo ─────────────────────
// Fuente única para color/ícono/desc, usada por Sidebar persistente y dashboard.
// Las claves son los `id` de apps/api/app/catalog.py (CATALOG). Si se agrega un
// módulo ahí, agregarlo aquí también.
import type { CatalogColor, CatalogModule } from "@/lib/types";

export interface ModuleVisual {
  /** Color sólido legacy (sidebar / fallback). */
  color: string;
  /** Color accent principal (vibrante, sobre fondo oscuro). */
  accent: string;
  /** Color accent más suave (fondo claro / subtle). */
  accentSoft: string;
  /** Gradiente lineal 135° usado en hero + atajos premium. */
  gradient: string;
  desc: string;
  icon: string;
  /** Prefijos de ruta que pertenecen a este módulo (sidebar activo). */
  routePrefixes: string[];
}

// Paleta tech premium — siempre con buen contraste sobre fondo oscuro Y claro.
export const COLOR_TOKENS: Record<CatalogColor, Omit<ModuleVisual, "desc" | "icon" | "routePrefixes">> = {
  cyan: {
    color: "#06b6d4",
    accent: "#22d3ee",
    accentSoft: "#0891b2",
    gradient: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
  },
  blue: {
    color: "#2563eb",
    accent: "#3b82f6",
    accentSoft: "#1d4ed8",
    gradient: "linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)",
  },
  emerald: {
    color: "#059669",
    accent: "#10b981",
    accentSoft: "#047857",
    gradient: "linear-gradient(135deg, #10b981 0%, #06b6d4 100%)",
  },
  amber: {
    color: "#d97706",
    accent: "#f59e0b",
    accentSoft: "#b45309",
    gradient: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
  },
  violet: {
    color: "#7c3aed",
    accent: "#8b5cf6",
    accentSoft: "#6d28d9",
    gradient: "linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)",
  },
};

export const MODULE_CFG: Record<string, ModuleVisual> = {
  modelacion: {
    ...COLOR_TOKENS.cyan,
    desc: "Importación ETABS, modelo OpenSees y análisis no lineal 3D",
    icon: "building",
    routePrefixes: ["/projects", "/building", "/wall-projects", "/wall-design"],
  },
  sismologia: {
    ...COLOR_TOKENS.blue,
    desc: "Espectros NSR-10 y procesamiento de acelerogramas",
    icon: "wave",
    routePrefixes: ["/seismic", "/ground-motion"],
  },
  secciones: {
    ...COLOR_TOKENS.emerald,
    desc: "Secciones RC con confinamiento Mander y fibras",
    icon: "section",
    routePrefixes: ["/analysis", "/sections"],
  },
  campo: {
    ...COLOR_TOKENS.amber,
    desc: "Triaje post-sismo ATC-20 / FEMA P-2018",
    icon: "clipboard",
    routePrefixes: ["/field-assessment"],
  },
  roadmap: {
    ...COLOR_TOKENS.violet,
    desc: "Módulos en diseño — evaluación de desempeño, riesgo y decisiones",
    icon: "gauge",
    routePrefixes: [],
  },
};

const FALLBACK = COLOR_TOKENS.cyan;

export function moduleVisual(id: string, _index?: number): ModuleVisual {
  return (
    MODULE_CFG[id] ?? {
      ...FALLBACK,
      desc: "",
      icon: "default",
      routePrefixes: [],
    }
  );
}

// ── Conteos derivados de un módulo del catálogo ──────────────────────────────
export interface ModuleStats {
  total: number;
  done: number;
  dev: number;
  idea: number;
}

export function moduleStats(mod: CatalogModule): ModuleStats {
  const total = mod.products.length;
  const done = mod.products.filter((p) => p.route).length;
  const dev = mod.products.filter((p) => p.estado === "en_desarrollo").length;
  const idea = mod.products.filter((p) => p.estado === "idea").length;
  return { total, done, dev, idea };
}

// ── Iconos SVG (stroke-based, grilla 24×24) ──────────────────────────────────
export const ICON_D: Record<string, string> = {
  home:       "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  wave:       "M2 12C4 8 6 8 8 12s4 8 6 4 4-8 6-4",
  section:    "M4 4h16v16H4zM4 9h16M4 14h16M9 4v16M14 4v16",
  curve:      "M3 20h4V13c0-3 3-5 5-5s3 2 3 4-1 4-1 8h7",
  building:   "M3 21h18M3 7l9-4 9 4M4 21V7M20 21V7M9 21v-4h6v4",
  skyscraper: "M5 21V8l4-2 4 2v13M13 21V3l4 2 4-2v18M7 11h2M7 14h2M7 17h2M15 7h2M15 11h2M15 15h2M15 18h2",
  seismograph:"M2 12h4l2-7 3 14 3-10 2 3h6",
  gauge:      "M5.6 17.4A8 8 0 1 1 18.4 17.4M12 12l4-5",
  fragility:  "M3 19c3 0 4-14 7-14s3 9 5 9 3-5 6-5",
  risk:       "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 8v4M12 16h.01",
  report:     "M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  import:     "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  settings:   "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  tool:       "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  column:     "M7 3h10v18H7zM7 8h10M7 13h10",
  calc:       "M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM8 6h8M8 10h3M13 10h3M8 14h3M13 14h3M8 18h8M8 18h8",
  clipboard:  "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5v2h6V5M9 14l2 2 4-4",
  wall:       "M3 4h18v6H3zM3 10h18v6H3zM3 16h18v4H3zM7 4v16M11 4v16M15 4v16M19 4v16",
  default:    "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 8v4M12 16h.01",
};

export function iconTypeFor(id: string): string {
  // Nuevos ids del catálogo reorganizado
  if (id === "constructor-modelos")             return "building";
  if (id === "analisis-no-lineal-3d")           return "skyscraper";
  if (id === "muros-rc-3d")                     return "wall";
  if (id === "espectros-nsr10")                 return "wave";
  if (id === "ground-motion")                   return "seismograph";
  if (id === "editor-secciones")                return "section";
  if (id === "interaccion-pm")                  return "section";
  if (id === "interaccion-pmm")                 return "curve";
  if (id === "momento-curvatura")               return "curve";
  if (id === "triaje-post-sismo")               return "clipboard";
  if (id === "desempeno")                       return "gauge";
  if (id === "riesgo")                          return "risk";
  if (id === "decisiones")                      return "report";

  // Legacy / fallback por regex (por si queda algo sin migrar)
  if (/safety-atc20|triage-fema/.test(id))      return "clipboard";
  if (/import|conv/.test(id))                   return "import";
  if (/^gm-spectrum|^gm-fft|^gm-multi/.test(id))return "wave";
  if (/^gm-timeseries/.test(id))                return "seismograph";
  if (/^gm-intensity/.test(id))                 return "gauge";
  if (/^gm-nonlinear/.test(id))                 return "curve";
  if (/^gm-/.test(id))                          return "seismograph";
  if (/espectro/.test(id))                      return "wave";
  if (/interaccion|diagrama/.test(id))          return "section";
  if (/curvatura|fibra/.test(id))               return "curve";
  if (/edificio/.test(id))                      return "building";
  if (/muros|muro|wall/.test(id))               return "wall";
  if (/registro|ciclico/.test(id))              return "seismograph";
  if (/desempeno|calculo-r|param|r-dif/.test(id))return "gauge";
  if (/fragilidad|vulnerabilidad|colapso/.test(id)) return "fragility";
  if (/perdida|recuperacion|riesgo/.test(id))   return "risk";
  if (/reporte/.test(id))                       return "report";
  if (/gestion|editor/.test(id))                return "settings";
  if (/axial|confinamiento/.test(id))           return "column";
  if (/conexion|acero|biblioteca/.test(id))     return "tool";
  if (/calculadora/.test(id))                   return "calc";
  return "default";
}

export function Icon({ id, color, size = 20, strokeWidth = 1.75 }: { id: string; color: string; size?: number; strokeWidth?: number }) {
  const d = ICON_D[iconTypeFor(id)] ?? ICON_D.default;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Ícono a nivel de módulo/grupo — usa `icon` de MODULE_CFG directamente. */
export function ModuleIcon({ type, color, size = 20, strokeWidth = 1.75 }: { type: string; color: string; size?: number; strokeWidth?: number }) {
  const d = ICON_D[type] ?? ICON_D.default;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
