/**
 * Paleta de color por región sísmica — fuente única usada por el mapa Leaflet,
 * los chips del listado Ground Motion y la leyenda de la página catálogo.
 *
 * Los colores son los accent vibrantes del paletón tech premium, elegidos para
 * leer bien tanto sobre tiles claros (Positron) como oscuros (Dark Matter).
 */

export const REGION_COLOR: Record<string, string> = {
  CALI:      "#3b82f6", // blue
  MANIZALES: "#10b981", // emerald
  PEREIRA:   "#f59e0b", // amber
  SGC:       "#ef4444", // red
};

const REGION_COLOR_FALLBACK = "#64748b";

export function regionColor(region: string): string {
  return REGION_COLOR[region] ?? REGION_COLOR_FALLBACK;
}

/**
 * Tono semáforo del tipo de suelo NSR-10 A.2.4:
 *  - A, B (roca firme / blanda) → emerald, favorable
 *  - C (muy densa / roca blanda) → cyan, intermedio
 *  - D (perfil rígido) → amber, atención
 *  - E (blando) → rose, desfavorable
 *  - F (especial, requiere evaluación) → violet
 */
export type SoilTone = "emerald" | "cyan" | "amber" | "rose" | "violet" | "neutral";

export function soilTone(soil: string | null | undefined): SoilTone {
  if (!soil) return "neutral";
  const s = soil.trim().toUpperCase();
  if (s === "A" || s === "B") return "emerald";
  if (s === "C") return "cyan";
  if (s === "D") return "amber";
  if (s === "E") return "rose";
  if (s === "F") return "violet";
  return "neutral";
}

export const SOIL_TONE_CLASS: Record<SoilTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/40",
  cyan:    "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 border-cyan-500/40",
  amber:   "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/40",
  rose:    "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/40",
  violet:  "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/40",
  neutral: "bg-[var(--panel-muted)]/50 text-[var(--text-muted)] border-[var(--panel-muted)]",
};
