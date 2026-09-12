"use client";

/**
 * PierResponseCurves — Curvas M-φ y V-δ del pier seleccionado durante el pushover.
 *
 * Muestra la respuesta local no lineal del pier en dos gráficas Plotly:
 *   • M-φ (momento vs curvatura estimada) — comportamiento a flexión en base
 *   • V-δ (cortante vs desplazamiento top) — comportamiento a corte
 *
 * Marca el punto de fluencia estimado (cambio de pendiente al 70% de la
 * secante inicial) para lectura rápida del comportamiento.
 */
import { useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { PierResponseData, DamageLevel } from "@/lib/structural-types";

interface Props {
  projectId: string;
  direction: string;
  pier:      string;
  story:     string;
  onClose?:  () => void;
}

const DAMAGE_COLOR: Record<DamageLevel, string> = {
  none: "#22c55e", minor: "#a3e635", moderate: "#eab308",
  severe: "#f97316", collapse: "#ef4444",
};

export default function PierResponseCurves({ projectId, direction, pier, story, onClose }: Props) {
  const [data, setData]     = useState<PierResponseData | null>(null);
  const [loading, setLoad]  = useState(true);
  const [error, setError]   = useState<string | null>(null);

  const mPhiRef = useRef<HTMLDivElement>(null);
  const vDelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    setLoad(true); setError(null); setData(null);
    structuralAnalysisApi.nlPushoverPierResponse(projectId, direction, pier, story)
      .then((d) => { if (mounted) { setData(d); setLoad(false); } })
      .catch((e: Error) => { if (mounted) { setError(e.message || "Error"); setLoad(false); } });
    return () => { mounted = false; };
  }, [projectId, direction, pier, story]);

  // Render M-φ
  useEffect(() => {
    if (!data || !mPhiRef.current || !window.Plotly) return;
    const Plotly = window.Plotly;
    const xs = data.M_phi.map((p) => p.phi_1_per_m * 1000);   // 1/m → 1/km para lectura amable
    const ys = data.M_phi.map((p) => p.moment_kNm);
    const y_max = Math.max(...ys, 1);

    const traces: object[] = [{
      x: xs, y: ys, type: "scatter", mode: "lines+markers",
      line: { color: "#3b82f6", width: 2.5 },
      marker: { size: 4, color: "#3b82f6" },
      hovertemplate: "φ = %{x:.4f} ×10⁻³ /m<br>M = %{y:.1f} kN·m<extra></extra>",
      name: "M-φ",
    }];

    if (data.yield_M_phi) {
      traces.push({
        x: [data.yield_M_phi.phi_1_per_m * 1000],
        y: [data.yield_M_phi.moment_kNm],
        type: "scatter", mode: "markers+text",
        marker: { size: 12, color: "#f59e0b", symbol: "star", line: { color: "#000", width: 1 } },
        text: ["Fluencia"], textposition: "top center", textfont: { size: 10, color: "#f59e0b" },
        hovertemplate: "Fluencia estimada<br>φ = %{x:.4f} ×10⁻³/m<br>M = %{y:.1f} kN·m<extra></extra>",
        name: "Fluencia",
        showlegend: false,
      });
    }

    Plotly.newPlot(mPhiRef.current, traces, {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 11, color: "var(--text-muted)" },
      margin: { t: 10, r: 10, b: 45, l: 55 },
      xaxis: {
        title: { text: "Curvatura φ (×10⁻³ /m)", font: { size: 11 } },
        gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.35)",
      },
      yaxis: {
        title: { text: "Momento base (kN·m)", font: { size: 11 } },
        gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.35)",
        range: [0, y_max * 1.1],
      },
      showlegend: false,
    }, { responsive: true, displayModeBar: false });
  }, [data]);

  // Render V-δ
  useEffect(() => {
    if (!data || !vDelRef.current || !window.Plotly) return;
    const Plotly = window.Plotly;
    const xs = data.V_delta.map((p) => Math.abs(p.delta_m) * 1000);   // m → mm
    const ys = data.V_delta.map((p) => Math.abs(p.shear_kN));
    const y_max = Math.max(...ys, 1);

    const traces: object[] = [{
      x: xs, y: ys, type: "scatter", mode: "lines+markers",
      line: { color: "#22c55e", width: 2.5 },
      marker: { size: 4, color: "#22c55e" },
      hovertemplate: "δ = %{x:.2f} mm<br>V = %{y:.1f} kN<extra></extra>",
      name: "V-δ",
    }];

    if (data.yield_V_delta) {
      traces.push({
        x: [Math.abs(data.yield_V_delta.delta_m) * 1000],
        y: [Math.abs(data.yield_V_delta.shear_kN)],
        type: "scatter", mode: "markers+text",
        marker: { size: 12, color: "#f59e0b", symbol: "star", line: { color: "#000", width: 1 } },
        text: ["Fluencia"], textposition: "top center", textfont: { size: 10, color: "#f59e0b" },
        hovertemplate: "Fluencia estimada<br>δ = %{x:.2f} mm<br>V = %{y:.1f} kN<extra></extra>",
        name: "Fluencia",
        showlegend: false,
      });
    }

    Plotly.newPlot(vDelRef.current, traces, {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 11, color: "var(--text-muted)" },
      margin: { t: 10, r: 10, b: 45, l: 55 },
      xaxis: {
        title: { text: "Desplazamiento top δ (mm)", font: { size: 11 } },
        gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.35)",
      },
      yaxis: {
        title: { text: "Cortante base V (kN)", font: { size: 11 } },
        gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.35)",
        range: [0, y_max * 1.1],
      },
      showlegend: false,
    }, { responsive: true, displayModeBar: false });
  }, [data]);

  // ═════════════════════════════════════════════════════════════════════════
  const damageColor = data?.damage ? DAMAGE_COLOR[data.damage.level] : "var(--text)";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Respuesta Local — Pier <span className="font-mono">{pier}</span> · {story} · Dir {direction}
        </span>
        {data && (
          <span className="text-[11px] text-[var(--text-muted)]">
            lw = <span className="font-mono">{data.lw_m.toFixed(2)} m</span> ·
            hw = <span className="font-mono">{data.hw_m.toFixed(2)} m</span> ·
            lp = <span className="font-mono">{data.lp_m.toFixed(2)} m</span>
          </span>
        )}
        {data?.damage && (
          <span className="ml-2 px-2 py-0.5 rounded text-[10px] font-bold"
                style={{ background: `${damageColor}22`, color: damageColor }}>
            DI = {data.damage.di.toFixed(3)} · {data.damage.level}
          </span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto px-2 py-1 rounded text-[11px] bg-[var(--surface)] hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            ✕ Cerrar
          </button>
        )}
      </div>

      {loading && (
        <div className="p-6 flex items-center justify-center">
          <p className="text-sm text-[var(--text-muted)] animate-pulse">Extrayendo respuesta del pier...</p>
        </div>
      )}

      {error && (
        <div className="p-6">
          <p className="text-sm text-red-600 font-medium">Error al cargar respuesta local</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">{error}</p>
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
            <div className="p-4 md:border-r md:border-[var(--border)]">
              <p className="text-[11px] font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Momento – Curvatura</p>
              <div ref={mPhiRef} style={{ height: 300 }} />
              {data.yield_M_phi && (
                <p className="text-[10px] text-[var(--text-muted)] mt-1 text-center">
                  Fluencia estimada · M<sub>y</sub> ≈ <span className="font-mono">{data.yield_M_phi.moment_kNm.toFixed(1)} kN·m</span>
                  {" "}· φ<sub>y</sub> ≈ <span className="font-mono">{(data.yield_M_phi.phi_1_per_m * 1000).toFixed(3)} ×10⁻³ /m</span>
                </p>
              )}
            </div>
            <div className="p-4">
              <p className="text-[11px] font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Cortante – Desplazamiento</p>
              <div ref={vDelRef} style={{ height: 300 }} />
              {data.yield_V_delta && (
                <p className="text-[10px] text-[var(--text-muted)] mt-1 text-center">
                  Fluencia estimada · V<sub>y</sub> ≈ <span className="font-mono">{Math.abs(data.yield_V_delta.shear_kN).toFixed(1)} kN</span>
                  {" "}· δ<sub>y</sub> ≈ <span className="font-mono">{(Math.abs(data.yield_V_delta.delta_m) * 1000).toFixed(2)} mm</span>
                </p>
              )}
            </div>
          </div>

          <div className="px-4 py-2 border-t border-[var(--border)] bg-[var(--surface-2)]">
            <p className="text-[10px] text-[var(--text-muted)]">
              Estimaciones: φ = drift/l<sub>p</sub> (Priestley 2007, l<sub>p</sub> = 0.5·l<sub>w</sub>) ·
              M<sub>base</sub> proyectado sobre normal horizontal al muro ·
              V<sub>base</sub> proyectado sobre dirección del muro.
              Punto de fluencia: cambio de pendiente al 70% de la secante inicial.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
