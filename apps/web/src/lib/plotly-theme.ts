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
