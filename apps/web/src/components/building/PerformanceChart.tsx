"use client";

import { useEffect, useRef, useState } from "react";
import type { PerformanceResult } from "@/lib/building-types";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Plotly: any;
  }
}

interface Props {
  data: PerformanceResult;
  direction?: "X" | "Y";
}

export function PerformanceChart({ data, direction = "X" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(!!window?.Plotly);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plotly) { setPlotlyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.onload = () => setPlotlyReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!plotlyReady || !containerRef.current) return;
    renderChart();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, data]);

  function renderChart() {
    const Plotly = window.Plotly;
    if (!Plotly || !containerRef.current) return;

    const { capacity_adrs, demand_elastic, demand_reduced, bilinear_Sd, bilinear_Sa, performance_point, performance_level, total_height_m } = data;
    const pp = performance_point;

    // Convert Sd m → cm for readability
    const cap_Sd  = capacity_adrs.Sd.map((v) => v * 100);
    const dem_e_Sd = demand_elastic.Sd.map((v) => v * 100);
    const dem_r_Sd = demand_reduced.Sd.map((v) => v * 100);
    const bil_Sd  = bilinear_Sd.map((v) => v * 100);
    const pp_Sd   = pp.Sd_pp * 100;

    // Drift limit lines in Sd space (cm)
    const driftLimits = [
      { drift_pct: 0.70, label: "IO",  color: "#22C55E" },
      { drift_pct: 2.50, label: "LS",  color: "#F59E0B" },
      { drift_pct: 5.00, label: "CP",  color: "#EF4444" },
    ];

    const saMax = Math.max(
      ...capacity_adrs.Sa,
      ...demand_elastic.Sa.slice(0, Math.ceil(demand_elastic.Sa.length * 0.5)),
    ) * 1.15;

    const sdMax = Math.max(
      ...cap_Sd,
      ...dem_e_Sd.filter((_, i) => demand_elastic.Sd[i] < data.capacity_adrs.Sd[data.capacity_adrs.Sd.length - 1] * 1.3),
      pp_Sd * 1.3,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [];

    // Performance level background bands
    let prevSd = 0;
    const bandColors: Record<string, string> = { IO: "#22C55E", LS: "#F59E0B", CP: "#EF4444", C: "#EF4444" };
    for (const lim of driftLimits) {
      const limSd = (lim.drift_pct / 100) * total_height_m * 100;
      traces.push({
        type: "scatter",
        mode: "none",
        x: [prevSd, limSd, limSd, prevSd, prevSd],
        y: [0, 0, saMax, saMax, 0],
        fill: "toself",
        fillcolor: bandColors[lim.label] + "12",
        line: { width: 0 },
        name: lim.label,
        showlegend: false,
        hoverinfo: "skip",
      });
      traces.push({
        type: "scatter",
        mode: "lines",
        x: [limSd, limSd],
        y: [0, saMax],
        line: { color: bandColors[lim.label] + "60", width: 1, dash: "dot" },
        name: lim.label,
        showlegend: false,
        hoverinfo: "skip",
      });
      prevSd = limSd;
    }

    // Elastic demand spectrum
    traces.push({
      type: "scatter", mode: "lines",
      x: dem_e_Sd,
      y: demand_elastic.Sa,
      name: `Demanda elástica (β=5%)`,
      line: { color: "#F59E0B", width: 2 },
      hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Demanda elástica</extra>",
    });

    // Reduced demand spectrum
    traces.push({
      type: "scatter", mode: "lines",
      x: dem_r_Sd,
      y: demand_reduced.Sa,
      name: `Demanda reducida (β=${pp.beta_eff.toFixed(0)}%)`,
      line: { color: "#EF4444", width: 1.5, dash: "dash" },
      hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Demanda reducida</extra>",
    });

    // Bilinear idealization
    traces.push({
      type: "scatter", mode: "lines",
      x: bil_Sd,
      y: bilinear_Sa,
      name: "Bilineal idealizada",
      line: { color: "#94A3B8", width: 1.5, dash: "dot" },
      hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Bilineal</extra>",
    });

    // Capacity curve
    traces.push({
      type: "scatter", mode: "lines",
      x: cap_Sd,
      y: capacity_adrs.Sa,
      name: `Capacidad Dir ${direction}`,
      line: { color: "#3B82F6", width: 2.5 },
      hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Capacidad</extra>",
    });

    // Performance point
    traces.push({
      type: "scatter", mode: "markers+text",
      x: [pp_Sd],
      y: [pp.Sa_pp],
      name: "Punto de desempeño",
      marker: {
        symbol: "star",
        size: 14,
        color: performance_level.color,
        line: { color: "#fff", width: 1.5 },
      },
      text: [`PP`],
      textposition: "top right",
      textfont: { color: performance_level.color, size: 11, family: "monospace" },
      hovertemplate: `Sd=${pp_Sd.toFixed(1)} cm<br>Sa=${pp.Sa_pp.toFixed(3)} g<br>Deriva=${pp.drift_pp.toFixed(2)}%<extra>Punto de desempeño</extra>`,
    });

    Plotly.react(containerRef.current!, traces, {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 65, r: 20, t: 30, b: 55 },
      xaxis: {
        title: "Desplazamiento espectral Sd (cm)",
        range: [0, Math.min(sdMax * 1.1, dem_e_Sd[dem_e_Sd.length - 1])],
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      yaxis: {
        title: "Aceleración espectral Sa (g)",
        range: [0, saMax],
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      legend: {
        font: { color: "var(--color-text)", size: 10 },
        bgcolor: "rgba(0,0,0,0.4)",
        bordercolor: "var(--color-border)",
        borderwidth: 1,
        x: 0.02, y: 0.98,
        xanchor: "left", yanchor: "top",
      },
      font: { color: "var(--color-text-muted)", size: 11 },
      annotations: [
        { x: (0.35 / 100) * total_height_m * 100, y: saMax * 0.92, text: "IO", showarrow: false, font: { color: "#22C55E", size: 10 } },
        { x: (1.60 / 100) * total_height_m * 100, y: saMax * 0.92, text: "LS", showarrow: false, font: { color: "#F59E0B", size: 10 } },
        { x: (3.75 / 100) * total_height_m * 100, y: saMax * 0.92, text: "CP", showarrow: false, font: { color: "#EF4444", size: 10 } },
      ],
    }, { responsive: true, displaylogo: false, displayModeBar: true });
  }

  const pp = data.performance_point;
  const pl = data.performance_level;

  return (
    <div className="flex flex-col gap-4">
      {/* Nivel de desempeño — badge principal */}
      <div
        className="flex items-center gap-4 rounded-lg border px-4 py-3"
        style={{
          borderColor: pl.color + "60",
          background:  pl.color + "14",
        }}
      >
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
          style={{ background: pl.color + "30", color: pl.color }}
        >
          {pl.code}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: pl.color }}>{pl.nombre}</p>
          <p className="text-xs text-text-muted">{pl.description}</p>
        </div>
      </div>

      {/* Métricas del punto de desempeño */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Sa en PP", value: `${pp.Sa_pp.toFixed(3)} g`, },
          { label: "Sd en PP", value: `${(pp.Sd_pp * 100).toFixed(1)} cm`, },
          { label: "Deriva techo", value: `${pp.drift_pp.toFixed(2)}%`, },
          { label: "β efect. / T efect.", value: `${pp.beta_eff.toFixed(0)}% / ${pp.T_eff.toFixed(2)} s`, },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-3 py-2.5">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
            <span className="font-mono text-sm font-semibold text-text">{value}</span>
          </div>
        ))}
      </div>

      {/* Parámetros sísmicos */}
      <div className="flex gap-3 text-[11px] text-text-muted">
        <span>Aa = <span className="font-mono text-text">{data.Aa}</span></span>
        <span>·</span>
        <span>Av = <span className="font-mono text-text">{data.Av}</span></span>
        <span>·</span>
        <span>Suelo <span className="font-mono text-text">{data.soil_type}</span></span>
        <span>·</span>
        <span>H = <span className="font-mono text-text">{data.total_height_m.toFixed(1)} m</span></span>
      </div>

      {/* Gráfica ADRS */}
      <div className="rounded-lg border border-border bg-surface" style={{ height: 440, position: "relative" }}>
        {!plotlyReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
            Cargando gráfica...
          </div>
        )}
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}
