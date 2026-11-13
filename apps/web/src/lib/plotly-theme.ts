// Tokens de color para gráficas Plotly adaptados al tema dark/light de la plataforma.

export function plotlyTheme(isDark: boolean) {
  const text = isDark ? "#97a1b8" : "#545b6c";
  const grid = isDark ? "#2a3350" : "#d7dbe4";
  const leg  = isDark ? "rgba(20,27,46,0.88)" : "rgba(255,255,255,0.92)";

  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor:  "rgba(0,0,0,0)",
    font:   { color: text, size: 11 },
    xaxis:  { color: text, gridcolor: grid, zerolinecolor: grid },
    yaxis:  { color: text, gridcolor: grid, zerolinecolor: grid },
    legend: { bgcolor: leg, bordercolor: grid, borderwidth: 1, font: { color: text, size: 10 } },
    // Extras para shapes / annotations
    refLineColor: isDark ? "#F87171" : "#c81e3a",
    text,
    grid,
  };
}

export function viewer3dTheme(isDark: boolean) {
  const grid = isDark ? "#1E293B" : "#cbd5e1";
  const axis = isDark ? "#475569" : "#94a3b8";
  const leg  = isDark ? "rgba(8,15,35,0.85)" : "rgba(255,255,255,0.92)";
  return {
    containerBg:     isDark
      ? "radial-gradient(ellipse at 35% 45%, #0d1832 0%, #060a14 100%)"
      : "radial-gradient(ellipse at 35% 45%, #e8eef8 0%, #f0f4fb 100%)",
    containerShadow: isDark
      ? "0 4px 32px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)"
      : "0 2px 16px rgba(0,0,0,0.07)",
    containerBorder: isDark ? "#1E293B" : "#d7dbe4",
    axisColor:  axis,
    gridColor:  grid,
    legendBg:   leg,
    legendBorder: grid,
    sceneUndeformed: isDark ? "#1e293b" : "#c4cfe0",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Premium layout helpers (2026-11-04) — API nueva coexiste con plotlyTheme().
// Pensados para paneles de resultados (pushover, NLTH): títulos de eje en
// negrilla, grilla sutil, zero line marcada, hover elegante.
// ─────────────────────────────────────────────────────────────────────────────

export const PLOTLY_COLORS = {
  primary:   "#0e7fa8",
  secondary: "#2563eb",
  success:   "#16a34a",
  warning:   "#b45309",
  danger:    "#c81e3a",
  muted:     "#64748b",
  dirX:      "#0e7fa8",
  dirY:      "#16a34a",
  neutral:   "#334155",
};

const FONT_FAMILY = "Inter, system-ui, -apple-system, sans-serif";

export const plotlyConfigPremium = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: [
    "lasso2d", "select2d", "autoScale2d",
    "hoverClosestCartesian", "hoverCompareCartesian", "toggleSpikelines",
  ],
  toImageButtonOptions: {
    format: "png" as const,
    filename: "grafico_performancelabs",
    scale: 2,
  },
};

/**
 * Axis config premium: título en <b>, grilla sutil, zero line marcada.
 * Combina con cualquier layout (puedes mergearlo encima de uno existente).
 */
export function plotlyAxisPremium(opts: {
  title?: string;
  zeroLine?: boolean;
  range?: [number, number];
  tickformat?: string;
  showGrid?: boolean;
} = {}): Record<string, unknown> {
  const { title, zeroLine = true, range, tickformat, showGrid = true } = opts;
  return {
    title: title ? {
      text: `<b>${title}</b>`,
      font: { family: FONT_FAMILY, size: 11, color: "var(--text)" },
      standoff: 10,
    } : undefined,
    gridcolor:     "rgba(148,163,184,0.18)",
    gridwidth:     1,
    griddash:      "solid",
    zeroline:      zeroLine,
    zerolinecolor: "rgba(100,116,139,0.55)",
    zerolinewidth: 1.25,
    showline:      true,
    linecolor:     "rgba(148,163,184,0.45)",
    linewidth:     1,
    tickcolor:     "rgba(148,163,184,0.45)",
    tickfont:      { family: FONT_FAMILY, size: 10, color: "var(--text-muted)" },
    showgrid:      showGrid,
    range,
    tickformat,
    mirror:        true,
    ticklen:       4,
  };
}

/**
 * Layout premium base: fonts Inter, márgenes generosos, hover elegante,
 * título a la izquierda. xTitle/yTitle se envuelven en <b> automáticamente.
 */
export function plotlyLayoutPremium(opts: {
  xTitle?: string;
  yTitle?: string;
  title?:  string;
  showLegend?: boolean;
  legendTop?: boolean;
  margin?: { t?: number; r?: number; b?: number; l?: number };
} = {}): Record<string, unknown> {
  const {
    xTitle, yTitle, title,
    showLegend = false, legendTop = true,
    margin = {},
  } = opts;

  return {
    paper_bgcolor: "transparent",
    plot_bgcolor:  "transparent",
    font: { family: FONT_FAMILY, size: 11, color: "var(--text-muted)" },
    title: title ? {
      text: title,
      x: 0.02, xanchor: "left",
      y: 0.98, yanchor: "top",
      font: { family: FONT_FAMILY, size: 13, color: "var(--text)", weight: 600 },
    } : undefined,
    margin: {
      t: margin.t ?? (title ? 46 : 20),
      r: margin.r ?? 20,
      b: margin.b ?? (xTitle ? 52 : 32),
      l: margin.l ?? (yTitle ? 64 : 48),
    },
    xaxis: plotlyAxisPremium({ title: xTitle }),
    yaxis: plotlyAxisPremium({ title: yTitle }),
    showlegend: showLegend,
    legend: showLegend ? {
      orientation: "h" as const,
      yanchor: legendTop ? "bottom" : "top",
      y: legendTop ? 1.02 : -0.22,
      xanchor: "left", x: 0,
      font: { family: FONT_FAMILY, size: 10, color: "var(--text)" },
      bgcolor: "rgba(0,0,0,0)",
    } : undefined,
    hoverlabel: {
      font:        { family: FONT_FAMILY, size: 11, color: "#fff" },
      bgcolor:     "rgba(15,23,42,0.92)",
      bordercolor: "rgba(15,23,42,0.92)",
      namelength:  40,
    },
  };
}
