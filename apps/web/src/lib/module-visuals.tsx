// ── Identidad visual de los módulos del catálogo ─────────────────────────────
// Fuente única para el color/ícono/descripción de cada módulo, usada tanto por
// el Sidebar persistente como por el dashboard. Las claves son los `id` de
// apps/api/app/catalog.py (CATALOG) — si se agrega un módulo ahí, agregarlo aquí.
import type { CatalogModule } from "@/lib/types";

export interface ModuleVisual {
  color: string;
  desc: string;
  icon: string;
  /** Prefijos de ruta que pertenecen a este módulo, para resaltar el ítem activo del sidebar. */
  routePrefixes: string[];
}

export const MODULE_CFG: Record<string, ModuleVisual> = {
  modelado: {
    color: "#0369a1",
    desc: "Análisis estructural preliminar: respuesta modal y espectral NSR-10",
    icon: "import",
    routePrefixes: ["/projects", "/seismic"],
  },
  secciones: {
    color: "#087f5b",
    desc: "Ingeniería de secciones RC: diagramas P-M, M-φ, PMM biaxial y verificación NSR-10",
    icon: "section",
    routePrefixes: ["/analysis", "/sections"],
  },
  "analisis-no-lineal-3d": {
    color: "#7c3aed",
    desc: "Análisis no lineal 3D de edificios: modal, pushover, dinámico e IDA",
    icon: "building",
    routePrefixes: ["/building"],
  },
  "muros-rc-3d": {
    color: "#b45309",
    desc: "Análisis no lineal de muros RC 3D con modelos E-SFI-MVLEM-3D y MVLEM_3D",
    icon: "column",
    routePrefixes: ["/wall-projects", "/wall-design"],
  },
  desempeno: {
    color: "#d97706",
    desc: "Evaluación del desempeño sísmico según ATC-40 / NSR-10 mediante CSM y ADRS",
    icon: "gauge",
    routePrefixes: [],
  },
  riesgo: {
    color: "#dc2626",
    desc: "Probabilidad de colapso, curvas de fragilidad y pérdidas económicas esperadas",
    icon: "risk",
    routePrefixes: [],
  },
  "ground-motion": {
    color: "#0891b2",
    desc: "Procesamiento y análisis de registros de aceleración sísmica: FFT, espectros, intensidad",
    icon: "seismograph",
    routePrefixes: ["/ground-motion"],
  },
  decisiones: {
    color: "#6d28d9",
    desc: "Reportes automáticos de desempeño sísmico y recomendaciones de intervención",
    icon: "report",
    routePrefixes: [],
  },
};

export const FALLBACK_COLORS = ["#0e7fa8", "#087f5b", "#7c3aed", "#b45309", "#d97706", "#dc2626", "#0891b2", "#6d28d9"];

export function moduleVisual(id: string, index: number): ModuleVisual {
  return MODULE_CFG[id] ?? { color: FALLBACK_COLORS[index % FALLBACK_COLORS.length], desc: "", icon: "default", routePrefixes: [] };
}

// ── Conteos derivados de un módulo del catálogo ──────────────────────────────
export interface ModuleStats {
  total: number;
  done: number; // productos con ruta activa (utilizables hoy)
  dev: number;  // estado === "en_desarrollo"
  idea: number; // estado === "idea"
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

export function iconTypeFor(id: string): string {
  if (/import|conv/.test(id))                              return "import";
  if (/^gm-spectrum|^gm-fft|^gm-multi/.test(id))          return "wave";
  if (/^gm-timeseries/.test(id))                           return "seismograph";
  if (/^gm-intensity/.test(id))                            return "gauge";
  if (/^gm-nonlinear/.test(id))                            return "curve";
  if (/^gm-/.test(id))                                     return "seismograph";
  if (/espectro/.test(id))                                  return "wave";
  if (/interaccion|diagrama/.test(id))                      return "section";
  if (/curvatura|fibra/.test(id))                           return "curve";
  if (/edificio/.test(id))                                  return "building";
  if (/muros|muro|wall/.test(id))                           return "column";
  if (/registro|ciclico/.test(id))                          return "seismograph";
  if (/desempeno|calculo-r|param|r-dif/.test(id))           return "gauge";
  if (/fragilidad|vulnerabilidad|colapso/.test(id))         return "fragility";
  if (/perdida|recuperacion|riesgo/.test(id))               return "risk";
  if (/reporte/.test(id))                                   return "report";
  if (/gestion|editor/.test(id))                            return "settings";
  if (/axial|confinamiento/.test(id))                       return "column";
  if (/conexion|acero|biblioteca/.test(id))                 return "tool";
  if (/calculadora/.test(id))                               return "calc";
  return "default";
}

export function Icon({ id, color, size = 20 }: { id: string; color: string; size?: number }) {
  const d = ICON_D[iconTypeFor(id)] ?? ICON_D.default;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Ícono a nivel de módulo (no de producto individual) — usa `icon` de MODULE_CFG directamente. */
export function ModuleIcon({ type, color, size = 20 }: { type: string; color: string; size?: number }) {
  const d = ICON_D[type] ?? ICON_D.default;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
