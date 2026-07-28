"use client";

import { useEffect, useRef, useState } from "react";
import type { PushoverResult } from "@/lib/building-types";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Plotly: any;
  }
}

interface Props {
  data: PushoverResult;
}

type Metric = "vbasal" | "vbasal_norm";

export function PushoverChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(!!window?.Plotly);
  const [metric, setMetric] = useState<Metric>("vbasal_norm");

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
  }, [plotlyReady, data, metric]);

  function renderChart() {
    const Plotly = window.Plotly;
    if (!Plotly || !containerRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [];
    const yLabel = metric === "vbasal" ? "Cortante basal Vb (kN)" : "Vb / W";

    if (data.X) {
      const d = data.X;
      traces.push({
        type: "scatter", mode: "lines",
        x: d.dtecho,
        y: d[metric] as number[],
        name: "Dir X",
        line: { color: "var(--color-accent)", width: 2 },
      });
    }

    if (data.Y) {
      const d = data.Y;
      traces.push({
        type: "scatter", mode: "lines",
        x: d.dtecho,
        y: d[metric] as number[],
        name: "Dir Y",
        line: { color: "var(--color-success)", width: 2, dash: "dash" },
      });
    }

    Plotly.react(containerRef.current!, traces, {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 60, r: 20, t: 20, b: 50 },
      xaxis: {
        title: "Deriva de techo δ (%)",
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      yaxis: {
        title: yLabel,
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      legend: {
        font: { color: "var(--color-text)", size: 11 },
        bgcolor: "rgba(0,0,0,0)",
        x: 0.02, y: 0.98,
      },
      font: { color: "var(--color-text-muted)", size: 11 },
    }, { responsive: true, displaylogo: false, displayModeBar: true });
  }

  const summaryDir = (dir: "X" | "Y") => {
    const d = dir === "X" ? data.X : data.Y;
    if (!d) return null;
    const s = d.summary;
    return (
      <div
        key={dir}
        className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3"
        style={{ borderLeftColor: dir === "X" ? "var(--color-accent)" : "var(--color-success)", borderLeftWidth: 3 }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: dir === "X" ? "var(--color-accent)" : "var(--color-success)" }}>
          Dirección {dir}
        </span>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
          <span className="text-text-muted">Vb máx</span>
          <span className="font-mono text-text">{s.vmax_kN.toFixed(1)} kN</span>
          <span className="text-text-muted">Vb/W máx</span>
          <span className="font-mono text-text">{s.vmax_norm.toFixed(4)}</span>
          <span className="text-text-muted">Deriva techo</span>
          <span className="font-mono text-text">{s.drift_techo_max.toFixed(2)}%</span>
          <span className="text-text-muted">Pasos</span>
          <span className="font-mono text-text">{s.n_steps}</span>
          <span className="text-text-muted">Estado</span>
          <span className="font-mono" style={{ color: s.status === "success" ? "var(--color-success)" : "var(--color-warning)" }}>
            {s.status}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Resumen por dirección */}
      <div className="flex flex-wrap gap-4">
        {summaryDir("X")}
        {summaryDir("Y")}
      </div>

      {/* Toggle métrica */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Eje Y:</span>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {([["vbasal", "Cortante (kN)"], ["vbasal_norm", "Vb / W"]] as [Metric, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMetric(key)}
              className={`px-3 py-1.5 font-medium transition-colors ${metric === key ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Gráfica */}
      <div className="rounded-lg border border-border bg-surface" style={{ height: 420, position: "relative" }}>
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
