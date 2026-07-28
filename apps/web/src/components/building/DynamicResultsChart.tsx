"use client";

import { useEffect, useRef, useState } from "react";
import type { DynamicResult } from "@/lib/building-types";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Plotly: any;
  }
}

interface Props {
  data: DynamicResult;
}

type ChartTab = "envelope" | "ida";

const FLOORS_MAX = 40;

function makeFloorLabels(n: number) {
  return Array.from({ length: n }, (_, i) => (i === 0 ? "Base" : `P${i}`));
}

export function DynamicResultsChart({ data }: Props) {
  const envelopeRef = useRef<HTMLDivElement>(null);
  const idaRef      = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(!!(typeof window !== "undefined" && window.Plotly));
  const [tab, setTab] = useState<ChartTab>("envelope");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plotly) { setPlotlyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.onload = () => setPlotlyReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!plotlyReady) return;
    if (tab === "envelope") renderEnvelope();
    else renderIda();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, data, tab]);

  function renderEnvelope() {
    const Plotly = window.Plotly;
    if (!Plotly || !envelopeRef.current) return;

    const { drift_x, drift_y } = data.envelope;
    const nFloors = Math.min(drift_x.mean.length, FLOORS_MAX);
    const floors = makeFloorLabels(nFloors);

    const buildEnvelopeTraces = (
      curve: typeof drift_x,
      color: string,
      dir: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any[] => [
      {
        type: "scatter", mode: "lines", name: `p84 Dir ${dir}`,
        x: curve.p84.slice(0, nFloors).map((v) => v * 100),
        y: floors,
        orientation: "h",
        line: { color, width: 1, dash: "dot" },
        showlegend: false,
      },
      {
        type: "scatter", mode: "lines", name: `p16 Dir ${dir}`,
        x: curve.p16.slice(0, nFloors).map((v) => v * 100),
        y: floors,
        orientation: "h",
        fill: "tonextx",
        fillcolor: `${color}22`,
        line: { color, width: 1, dash: "dot" },
        showlegend: false,
      },
      {
        type: "scatter", mode: "lines", name: `Media Dir ${dir}`,
        x: curve.mean.slice(0, nFloors).map((v) => v * 100),
        y: floors,
        orientation: "h",
        line: { color, width: 2.5 },
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [
      ...buildEnvelopeTraces(drift_x, "var(--color-accent)", "X"),
      ...buildEnvelopeTraces(drift_y, "var(--color-success)", "Y"),
    ];

    Plotly.react(envelopeRef.current!, traces, {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 50, r: 20, t: 20, b: 50 },
      xaxis: {
        title: "Deriva entre piso (%)",
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      yaxis: {
        title: "Nivel",
        gridcolor: "var(--color-border)",
        color: "var(--color-text-muted)",
        type: "category",
      },
      legend: { font: { color: "var(--color-text)", size: 11 }, bgcolor: "rgba(0,0,0,0)" },
      font: { color: "var(--color-text-muted)", size: 11 },
    }, { responsive: true, displaylogo: false, displayModeBar: true });
  }

  function renderIda() {
    const Plotly = window.Plotly;
    if (!Plotly || !idaRef.current) return;

    const { ida_curve } = data;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [
      {
        type: "scatter", mode: "lines",
        name: "p84",
        x: ida_curve.map((pt) => pt.drift_p84 * 100),
        y: ida_curve.map((pt) => pt.sa_p84),
        line: { color: "var(--color-warning)", width: 1.5, dash: "dot" },
      },
      {
        type: "scatter", mode: "lines",
        name: "p16",
        x: ida_curve.map((pt) => pt.drift_p16 * 100),
        y: ida_curve.map((pt) => pt.sa_p16),
        fill: "tonextx",
        fillcolor: "var(--color-warning)22",
        line: { color: "var(--color-warning)", width: 1.5, dash: "dot" },
      },
      {
        type: "scatter", mode: "lines+markers",
        name: "Media",
        x: ida_curve.map((pt) => pt.drift_mean * 100),
        y: ida_curve.map((pt) => pt.sa_mean),
        line: { color: "var(--color-accent)", width: 2.5 },
        marker: { size: 5 },
      },
    ];

    Plotly.react(idaRef.current!, traces, {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 60, r: 20, t: 20, b: 50 },
      xaxis: {
        title: "Deriva máxima entre piso (%)",
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      yaxis: {
        title: "Sa(T₁, 5%) (g)",
        gridcolor: "var(--color-border)",
        zerolinecolor: "var(--color-border)",
        color: "var(--color-text-muted)",
      },
      legend: { font: { color: "var(--color-text)", size: 11 }, bgcolor: "rgba(0,0,0,0)" },
      font: { color: "var(--color-text-muted)", size: 11 },
    }, { responsive: true, displaylogo: false, displayModeBar: true });
  }

  const { n_pairs_run, n_success, elapsed_s } = data;

  return (
    <div className="flex flex-col gap-4">
      {/* Resumen */}
      <div className="flex flex-wrap gap-4">
        {[
          { label: "Pares ejecutados", value: n_pairs_run },
          { label: "Pares exitosos", value: n_success },
          { label: "Tasa éxito", value: `${((n_success / Math.max(n_pairs_run, 1)) * 100).toFixed(0)}%` },
          { label: "Tiempo total", value: `${(elapsed_s / 60).toFixed(1)} min` },
          { label: "Escalas IDA", value: data.scale_factors.length },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-4 py-3">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
            <span className="font-mono text-base font-semibold text-text">{value}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex overflow-hidden rounded-md border border-border text-xs w-fit">
        {([["envelope", "Envolvente de derivas"], ["ida", "Curva IDA"]] as [ChartTab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-1.5 font-medium transition-colors ${tab === key ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Gráficas */}
      <div className="rounded-lg border border-border bg-surface" style={{ height: 460, position: "relative" }}>
        {!plotlyReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
            Cargando gráfica...
          </div>
        )}
        <div ref={envelopeRef} style={{ width: "100%", height: "100%", display: tab === "envelope" ? "block" : "none" }} />
        <div ref={idaRef}      style={{ width: "100%", height: "100%", display: tab === "ida"      ? "block" : "none" }} />
      </div>

      {/* Tabla de pares (colapsada) */}
      {data.pairs.length > 0 && (
        <details className="rounded-lg border border-border overflow-hidden">
          <summary className="cursor-pointer select-none bg-surface px-4 py-3 text-xs font-semibold text-text-muted hover:text-text">
            Detalle por par de registros ({data.pairs.length} pares)
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-hover">
                  {["Par", "Escala", "Registros", "Deriva X máx", "Deriva Y máx", "Sa geomedia (g)", "Estado"].map((h) => (
                    <th key={h} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.pairs.map((pair) => (
                  <tr key={pair.pair_id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-text">{pair.pair_id}</td>
                    <td className="px-3 py-2 font-mono text-xs text-text">{pair.scale.toFixed(2)}</td>
                    <td className="px-3 py-2 text-[11px] text-text-muted">{pair.record_names.join(", ")}</td>
                    <td className="px-3 py-2 font-mono text-xs text-text">{(Math.max(...pair.max_drift_x) * 100).toFixed(2)}%</td>
                    <td className="px-3 py-2 font-mono text-xs text-text">{(Math.max(...pair.max_drift_y) * 100).toFixed(2)}%</td>
                    <td className="px-3 py-2 font-mono text-xs text-text">{pair.sa_geomean_g?.toFixed(4) ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{
                          background: pair.status === "success" ? "var(--color-success)22" : "var(--color-danger)22",
                          color: pair.status === "success" ? "var(--color-success)" : "var(--color-danger)",
                        }}
                      >
                        {pair.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
