"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { N2Result } from "@/lib/structural-types";

interface Props {
  projectId: string;
  direction: "X" | "Y";
  /** "frames" (pórticos, rótulas ASCE 41) o "walls" (muros, pieres Park-Ang).
   *  Default "frames" por retrocompatibilidad. */
  system?:   "frames" | "walls";
}

type SaUnit = "mps2" | "g";
const G = 9.80665;

export default function N2PerformancePanel({ projectId, direction, system = "frames" }: Props) {
  const [result, setResult]   = useState<N2Result | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError]     = useState<string | null>(null);
  const [saUnit, setSaUnit]   = useState<SaUnit>("mps2");
  const divRef = useRef<HTMLDivElement>(null);

  // Factor de conversión: Sa_display = Sa_mps2 * k
  const k = saUnit === "g" ? 1.0 / G : 1.0;
  const uLabel = saUnit === "g" ? "g" : "m/s²";

  // Carga automática si ya hay un N2 persistido
  useEffect(() => {
    let cancelled = false;
    setResult(null); setError(null);
    structuralAnalysisApi.getN2(projectId, direction, system)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { /* 404 esperado si aún no se ha calculado */ });
    return () => { cancelled = true; };
  }, [projectId, direction, system]);

  const compute = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await structuralAnalysisApi.computeN2(projectId, direction, system);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, direction, system]);

  // Plotly ADRS
  useEffect(() => {
    if (!result || !divRef.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    // Convertir todas las series Sa a la unidad seleccionada (m/s² o g)
    const scale = (arr: number[]) => arr.map((v) => v * k);

    const traces: Record<string, unknown>[] = [
      // Espectro elástico
      {
        x: result.spectrum.Sd_m, y: scale(result.spectrum.Sa_mps2),
        type: "scatter", mode: "lines",
        name: "Espectro NSR-10 (I·Sa)",
        line: { color: "#0f172a", width: 2 },
      },
      // Capacidad útil (hasta 20% drop)
      {
        x: result.capacity.Sd_useful_m, y: scale(result.capacity.Sa_useful_mps2),
        type: "scatter", mode: "lines",
        name: "Capacidad SDOF",
        line: { color: "#2563eb", width: 3 },
      },
    ];
    // Rama degradada (si existe)
    if (result.capacity.Sd_degraded_m.length > 0) {
      traces.push({
        x: result.capacity.Sd_degraded_m, y: scale(result.capacity.Sa_degraded_mps2),
        type: "scatter", mode: "lines",
        name: "Capacidad degradada",
        line: { color: "#60a5fa", width: 2, dash: "dot" },
        opacity: 0.6,
      });
    }
    // Bilineal
    traces.push({
      x: result.capacity.bilinear_sd, y: scale(result.capacity.bilinear_sa),
      type: "scatter", mode: "lines+markers",
      name: "Bilineal (equal-energy)",
      line: { color: "#dc2626", width: 2, dash: "dash" },
      marker: { size: 6 },
    });
    // Punto de desempeño
    const Sd = result.sdof.Sd_target_m;
    const Sa_at_target_mps2 = result.sdof.is_collapse
      ? result.sdof.Say_mps2
      : Math.min(result.sdof.Say_mps2, result.sdof.Sae_mps2);
    const Sa_at_target = Sa_at_target_mps2 * k;
    traces.push({
      x: [Sd], y: [Sa_at_target],
      type: "scatter", mode: "markers",
      name: result.sdof.is_collapse ? "Colapso" : "Punto de desempeño",
      marker: {
        size: 14, color: result.sdof.is_collapse ? "#ef4444" : "#16a34a",
        symbol: result.sdof.is_collapse ? "x" : "circle",
        line: { color: "#000", width: 1 },
      },
    });
    // Proyecciones punteadas
    traces.push({
      x: [Sd, Sd, 0], y: [0, Sa_at_target, Sa_at_target],
      type: "scatter", mode: "lines",
      line: { color: "#94a3b8", width: 1, dash: "dot" },
      showlegend: false, hoverinfo: "skip",
    });

    Plotly.newPlot(divRef.current, traces, {
      paper_bgcolor: "transparent",
      plot_bgcolor:  "transparent",
      font: { size: 11 },
      margin: { t: 10, r: 10, b: 48, l: 60 },
      xaxis: { title: { text: "Sd (m)" }, gridcolor: "var(--border)", zeroline: false },
      yaxis: { title: { text: `Sa (${uLabel})` }, gridcolor: "var(--border)", zeroline: false },
      legend: { x: 1, y: 1, xanchor: "right", bgcolor: "rgba(255,255,255,0.4)" },
    }, { responsive: true, displayModeBar: false });

    return () => { if (divRef.current) Plotly.purge(divRef.current); };
  }, [result, k, uLabel]);

  return (
    <div className="flex flex-col gap-3 pl-glass rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col">
          <h4 className="text-sm font-semibold uppercase tracking-wider">
            Punto de desempeño — Método N2 (Fajfar 2000)
          </h4>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Dirección {direction}. Espectro NSR-10 del proyecto reducido por ductilidad; capacidad SDOF idealizada por equal-energy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle de unidades de Sa */}
          <div className="inline-flex rounded-md border border-[var(--border)] overflow-hidden text-[11px] font-medium">
            {(["mps2", "g"] as const).map((u) => (
              <button
                key={u}
                onClick={() => setSaUnit(u)}
                className={`px-2 py-1 transition-colors ${
                  saUnit === u
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
                title={`Mostrar Sa en ${u === "g" ? "g" : "m/s²"}`}
              >
                {u === "g" ? "g" : "m/s²"}
              </button>
            ))}
          </div>
          <button
            onClick={compute}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--accent)] text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {loading ? "Calculando…" : result ? "Recalcular" : "Calcular N2"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {!result && !loading && !error && (
        <p className="text-xs text-[var(--text-muted)] italic">
          Pulsa "Calcular N2" para obtener el punto de desempeño del edificio en esta dirección.
          Requiere pushover + modal + parámetros sísmicos del proyecto.
        </p>
      )}

      {result && (
        <>
          {result.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex flex-col gap-1">
              {result.warnings.map((w, i) => <span key={i}>⚠ {w}</span>)}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,320px)] gap-4">
            {/* ADRS plot */}
            <div ref={divRef} style={{ height: 340 }} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]" />

            {/* Parámetros N2 */}
            <div className="flex flex-col gap-2">
              <ParamGroup title="MDOF → SDOF">
                <Row k="Γ₁" v={result.sdof.gamma_1.toFixed(3)} />
                <Row k="m* (ton)" v={result.sdof.m_ast_ton.toFixed(1)} />
                <Row k="T* (s)"   v={result.sdof.T_star.toFixed(3)} />
                <Row k="Tc (s)"   v={result.sdof.Tc.toFixed(3)} />
              </ParamGroup>

              <ParamGroup title="Bilineal (equal-energy)">
                <Row k={`Say (${uLabel})`} v={(result.sdof.Say_mps2 * k).toFixed(saUnit === "g" ? 4 : 3)} />
                <Row k="Sdy (m)"           v={result.sdof.Sdy_m.toFixed(4)} />
                <Row k="K* (1/s²)"         v={result.sdof.K_star.toFixed(1)} />
                <Row k="20% drop"          v={result.sdof.strength_drop_found ? "sí" : "no"} />
              </ParamGroup>

              <ParamGroup title="Demanda">
                <Row k={`Sae (${uLabel})`} v={(result.sdof.Sae_mps2 * k).toFixed(saUnit === "g" ? 4 : 3)} />
                <Row k="Sde (m)"           v={result.sdof.Sde_m.toFixed(4)} />
                <Row k="Rμ"                v={result.sdof.R_mu.toFixed(3)} />
                <Row k="Regla"             v={result.sdof.rule === "equal_displacement" ? "igual despl." : "igual energía"} />
              </ParamGroup>

              <ParamGroup
                title="Punto de desempeño"
                emphasis={result.sdof.is_collapse ? "danger" : "success"}
              >
                <Row k="Sd objetivo (m)" v={result.sdof.Sd_target_m.toFixed(4)} />
                <Row k="D techo (m)"     v={result.mdof_target.D_target_m.toFixed(4)} />
                <Row k="μ (ductilidad)"  v={result.sdof.ductility.toFixed(2)} />
                <Row k="Deriva (%)"      v={(result.mdof_target.drift_pct ?? 0).toFixed(3)} />
                <Row k="Vb (kN)"         v={(result.mdof_target.base_shear_kN ?? 0).toFixed(1)} />
              </ParamGroup>
            </div>
          </div>

          {/* Estado del edificio en δ_target */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 flex flex-col gap-1">
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {system === "walls" ? "Pieres por nivel de daño (Park-Ang)" : "Rótulas por nivel ASCE 41"}
              {" "}en δ_target (paso {result.mdof_target.pushover_step ?? "—"})
            </p>
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              {system === "walls" ? (
                <>
                  <Pill color="#22c55e" label="Menor"    n={result.mdof_target.n_piers_minor    ?? 0} />
                  <Pill color="#eab308" label="Moderado" n={result.mdof_target.n_piers_moderate ?? 0} />
                  <Pill color="#f97316" label="Severo"   n={result.mdof_target.n_piers_severe   ?? 0} />
                  <Pill color="#ef4444" label="Colapso"  n={result.mdof_target.n_piers_collapse ?? 0} />
                </>
              ) : (
                <>
                  <Pill color="#22c55e" label="IO"      n={result.mdof_target.n_hinges_IO       ?? 0} />
                  <Pill color="#eab308" label="LS"      n={result.mdof_target.n_hinges_LS       ?? 0} />
                  <Pill color="#f97316" label="CP"      n={result.mdof_target.n_hinges_CP       ?? 0} />
                  <Pill color="#ef4444" label="Post-CP" n={result.mdof_target.n_hinges_collapse ?? 0} />
                </>
              )}
              <span className="text-[var(--text-muted)] italic ml-auto">
                Conteo del máximo histórico de la curva pushover, no del paso δ_target.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-[var(--text-muted)]">{k}</span>
      <span className="font-mono text-[var(--text)]">{v}</span>
    </div>
  );
}

function ParamGroup({
  title, emphasis, children,
}: {
  title: string;
  emphasis?: "success" | "danger";
  children: React.ReactNode;
}) {
  const borderCls = emphasis === "danger" ? "border-red-300" :
                    emphasis === "success" ? "border-green-300" :
                    "border-[var(--border)]";
  const bgCls = emphasis === "danger" ? "bg-red-50" :
                emphasis === "success" ? "bg-green-50" :
                "bg-[var(--surface-2)]";
  return (
    <div className={`rounded-lg border ${borderCls} ${bgCls} px-3 py-2 flex flex-col gap-0.5`}>
      <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
        {title}
      </p>
      {children}
    </div>
  );
}

function Pill({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span
      className="px-2 py-0.5 rounded font-mono flex items-center gap-1"
      style={{ background: `${color}22`, color }}
    >
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="font-semibold">{label}</span>
      <span>{n}</span>
    </span>
  );
}
