"use client";

import { useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { FrameElementResponse } from "@/lib/structural-types";

interface Props {
  projectId:  string;
  direction:  string;
  fid:        string;
  end:        "i" | "j";
  onClose?:   () => void;
}

/**
 * Curva curvatura-paso de un extremo i|j de columna/viga durante el pushover.
 * Pinta tres plots: κ vs step, κ vs deriva, y Vb vs deriva (ya resumida).
 */
export default function FrameElementResponseCurve({
  projectId, direction, fid, end, onClose,
}: Props) {
  const [data, setData]     = useState<FrameElementResponse | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [loading, setLoad]  = useState<boolean>(true);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad(true); setError(null); setData(null);
    structuralAnalysisApi.nlFrameElementResponse(projectId, direction, fid, end)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoad(false); });
    return () => { cancelled = true; };
  }, [projectId, direction, fid, end]);

  useEffect(() => {
    if (!chartRef.current || !data) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const steps  = data.curve.map((p) => p.step);
    const kappa  = data.curve.map((p) => p.kappa_1_per_m);
    const drift  = data.curve.map((p) => p.drift_pct);

    const traces: Array<Record<string, unknown>> = [{
      x: drift, y: kappa, mode: "lines+markers",
      line: { color: "#3b82f6", width: 2 },
      marker: { size: 3 },
      name: "κ",
      hovertemplate: "paso %{text}<br>deriva %{x:.3f}%<br>κ=%{y:.4f} 1/m<extra></extra>",
      text: steps,
    }];

    // Marcadores de niveles de daño (IO/LS/CP → líneas horizontales en κ equivalente)
    if (data.hinge) {
      const h = data.hinge;
      // Interpretamos κ_IO como la curvatura cuando θ_p ≈ θ_IO (muy aproximado)
      // No pintamos horizontales rigurosas, pero sí anotamos el nivel máximo
    }

    Plotly.newPlot(chartRef.current, traces, {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 10 },
      margin: { t: 10, r: 10, b: 40, l: 50 },
      xaxis: { title: "Deriva de techo (%)", gridcolor: "var(--border)" },
      yaxis: { title: "Curvatura κ (1/m)",   gridcolor: "var(--border)" },
      showlegend: false,
    }, { responsive: true, displayModeBar: false });

    return () => { if (chartRef.current) Plotly.purge(chartRef.current); };
  }, [data]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Respuesta no lineal — {data?.kind === "column" ? "Columna" : "Viga"} {fid} · ext {end.toUpperCase()}
        </h4>
        {onClose && (
          <button onClick={onClose} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">
            Cerrar ×
          </button>
        )}
      </div>

      {loading && <p className="text-xs text-[var(--text-muted)] animate-pulse">Cargando curva…</p>}
      {error   && <p className="text-xs text-red-600">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Stat label="b × h"    value={`${data.b_m} × ${data.h_m} m`} />
            <Stat label="L"         value={`${data.L_m.toFixed(2)} m`} />
            <Stat label="l_p"       value={`${data.lp_m.toFixed(3)} m`} />
            <Stat
              label="Daño máx"
              value={data.hinge?.damage_level ?? "—"}
              value_mono={false}
              highlight={data.hinge?.damage_level}
            />
          </div>

          <div ref={chartRef} style={{ height: 240 }} />

          {data.hinge && (
            <div className="grid grid-cols-3 gap-3 text-[11px] border-t border-[var(--border)] pt-2">
              <Stat label="θ_p máx" value={`${(data.hinge.theta_p_max * 1000).toFixed(2)} mrad`} />
              <Stat label="θ_LS"    value={`${(data.hinge.theta_LS   * 1000).toFixed(2)} mrad`} />
              <Stat label="DCR"     value={data.hinge.dcr.toFixed(2)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}


function Stat({ label, value, value_mono = true, highlight }:
  { label: string; value: string; value_mono?: boolean; highlight?: string }) {
  const color = ({
    none: "#64748b", near_io: "#38bdf8",
    io: "#22c55e",   ls: "#eab308",
    cp: "#f97316",   collapse: "#ef4444",
  } as Record<string, string>)[highlight ?? ""] ?? "var(--text)";
  return (
    <div className="rounded-md bg-[var(--surface-2)] px-2 py-1">
      <p className="text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{label}</p>
      <p
        className={value_mono ? "font-mono text-xs font-medium" : "text-xs font-semibold"}
        style={{ color }}
      >
        {value}
      </p>
    </div>
  );
}
