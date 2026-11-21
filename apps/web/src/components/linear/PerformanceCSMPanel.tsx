"use client";

/**
 * Panel — Evaluacion de Desempeno por Espectro de Capacidad (ATC-40 / NSR-10).
 *
 * Portado desde /building al Constructor de Modelos. Jala las entradas de los
 * resultados ya persistidos:
 *   - Modal   -> T1
 *   - Pushover (muros o porticos) -> drift_pct + base_shear_kN
 *   - Datos globales -> W total y altura total via FullModelData / spectral
 *
 * Calcula V/W y envia la curva al endpoint sincrono /performance/csm/evaluate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  structuralAnalysisApi,
  structuralEditorApi,
  structuralPerformanceApi,
} from "@/lib/structural-api";
import type {
  FullModelData,
  ModalResult,
  NLPushoverDirResult,
  NLFramePushoverDirResult,
  PerformanceCSMResult,
  SpectralResult,
} from "@/lib/structural-types";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Plotly: any;
  }
}

interface Props {
  projectId: string;
}

type System = "walls" | "frames";
type Direction = "X" | "Y";

function usePlotly() {
  const [ready, setReady] = useState<boolean>(
    typeof window !== "undefined" && !!window.Plotly,
  );
  useEffect(() => {
    if (typeof window === "undefined" || window.Plotly) return;
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);
  return ready;
}

export default function PerformanceCSMPanel({ projectId }: Props) {
  const plotlyReady = usePlotly();

  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  const [system,    setSystem]    = useState<System>("frames");
  const [direction, setDirection] = useState<Direction>("X");

  // Entradas que se jalan al montar
  const [T1_s,         setT1]         = useState<number>(0);
  const [totalHeight,  setTotalHeight]= useState<number>(0);
  const [W_kN,         setW]          = useState<number>(0);
  const [pushX,        setPushX]      = useState<NLPushoverDirResult | NLFramePushoverDirResult | null>(null);
  const [pushY,        setPushY]      = useState<NLPushoverDirResult | NLFramePushoverDirResult | null>(null);
  const [result,       setResult]     = useState<PerformanceCSMResult | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);

  // ── Carga inicial ────────────────────────────────────────────────────────
  const loadInputs = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      // 1. Modal -> T1
      let modal: ModalResult | null = null;
      try { modal = await structuralAnalysisApi.getModalResult(projectId); } catch {}
      const T = modal?.T1 ?? modal?.T1_x ?? modal?.T1_y ?? 0;
      setT1(T);

      // 2. Model data -> total_height + W (via spectral FHE si existe)
      let model: FullModelData | null = null;
      try { model = await structuralEditorApi.modelData(projectId); } catch {}
      setTotalHeight(model?.metadata?.total_height_m ?? 0);

      let spec: SpectralResult | null = null;
      try { spec = await structuralAnalysisApi.getSpectralResult(projectId); } catch {}
      setW(spec?.fhe?.W_kN ?? 0);

      // 3. Pushover (walls o frames)
      try {
        if (system === "walls") {
          const r = await structuralPerformanceApi.getNLPushoverResult(projectId);
          setPushX(r.pushover_X ?? null);
          setPushY(r.pushover_Y ?? null);
        } else {
          const r = await structuralPerformanceApi.getNLFramePushoverResult(projectId);
          setPushX(r.pushover_X ?? null);
          setPushY(r.pushover_Y ?? null);
        }
      } catch {
        setPushX(null); setPushY(null);
      }
    } catch (e) {
      setError((e as Error).message || "Error cargando entradas");
    } finally {
      setLoading(false);
    }
  }, [projectId, system]);

  useEffect(() => { void loadInputs(); }, [loadInputs]);

  // ── Ejecucion ────────────────────────────────────────────────────────────
  const activePushover = direction === "X" ? pushX : pushY;
  const canEvaluate = !!activePushover && activePushover.steps.length >= 2
                       && T1_s > 0 && totalHeight > 0 && W_kN > 0;

  const missingReasons = useMemo(() => {
    const r: string[] = [];
    if (T1_s <= 0)       r.push("falta análisis modal (T₁)");
    if (totalHeight <= 0) r.push("falta altura total del edificio");
    if (W_kN <= 0)        r.push("falta análisis espectral (W sísmico)");
    if (!activePushover)  r.push(`falta pushover ${direction} (${system})`);
    else if (activePushover.steps.length < 2)
                          r.push(`pushover ${direction} tiene <2 puntos`);
    return r;
  }, [T1_s, totalHeight, W_kN, activePushover, direction, system]);

  async function handleEvaluate() {
    if (!canEvaluate || !activePushover) return;
    setComputing(true); setError(null);
    try {
      const dtecho_pct  = activePushover.steps.map((s) => s.drift_pct);
      const vbasal_norm = activePushover.steps.map((s) => s.base_shear_kN / W_kN);
      const r = await structuralPerformanceApi.evaluateCSM({
        project_id:     projectId,
        direction,
        dtecho_pct,
        vbasal_norm,
        total_height_m: totalHeight,
        T1_s,
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message || "Error evaluando desempeño");
    } finally {
      setComputing(false);
    }
  }

  // ── Render de la gráfica ADRS ────────────────────────────────────────────
  useEffect(() => {
    if (!result || !plotlyReady || !chartRef.current) return;
    renderADRSChart(chartRef.current, result, direction);
  }, [result, plotlyReady, direction]);

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text)]">
          Verificación por desempeño — Espectro de capacidad (ATC-40)
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          Compara la curva de capacidad del pushover contra el espectro de demanda
          NSR-10, encuentra el punto de desempeño y lo clasifica (IO/LS/CP/C).
        </p>
      </header>

      {/* Selector sistema + dirección */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Sistema</span>
          {(["frames", "walls"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSystem(s)}
              className={`px-3 py-1 rounded text-xs font-medium ${
                system === s ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
              }`}
            >
              {s === "frames" ? "Pórticos" : "Muros"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Dirección</span>
          {(["X", "Y"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`px-3 py-1 rounded text-xs font-medium ${
                direction === d ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <button
          onClick={handleEvaluate}
          disabled={!canEvaluate || computing}
          className="ml-auto px-4 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-700 transition"
        >
          {computing ? "Calculando..." : "Evaluar desempeño"}
        </button>
      </div>

      {/* Chips de entrada */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
        <InputChip label="T₁"  value={T1_s > 0 ? `${T1_s.toFixed(3)} s` : "—"} ok={T1_s > 0} />
        <InputChip label="H"   value={totalHeight > 0 ? `${totalHeight.toFixed(1)} m` : "—"} ok={totalHeight > 0} />
        <InputChip label="W"   value={W_kN > 0 ? `${W_kN.toFixed(0)} kN` : "—"} ok={W_kN > 0} />
        <InputChip
          label={`Pushover ${direction}`}
          value={activePushover ? `${activePushover.steps.length} pts` : "—"}
          ok={!!activePushover && activePushover.steps.length >= 2}
        />
      </div>

      {loading && (
        <p className="text-sm text-[var(--text-muted)]">Cargando entradas del pushover + modal…</p>
      )}

      {!loading && missingReasons.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          Faltan entradas: {missingReasons.join("; ")}.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
          {error}
        </div>
      )}

      {/* Resultado */}
      {result && (
        <div className="space-y-4">
          <div
            className="flex items-center gap-4 rounded-lg border px-4 py-3"
            style={{
              borderColor: result.performance_level.color + "60",
              background:  result.performance_level.color + "14",
            }}
          >
            <div
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
              style={{
                background: result.performance_level.color + "30",
                color:      result.performance_level.color,
              }}
            >
              {result.performance_level.code}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold" style={{ color: result.performance_level.color }}>
                {result.performance_level.nombre}
              </p>
              <p className="text-xs text-[var(--text-muted)]">{result.performance_level.description}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard label="Sa en PP"   value={`${result.performance_point.Sa_pp.toFixed(3)} g`} />
            <MetricCard label="Sd en PP"   value={`${(result.performance_point.Sd_pp * 100).toFixed(1)} cm`} />
            <MetricCard label="Deriva techo" value={`${result.performance_point.drift_pp.toFixed(2)} %`} />
            <MetricCard label="β ef / T ef" value={`${result.performance_point.beta_eff.toFixed(0)}% / ${result.performance_point.T_eff.toFixed(2)} s`} />
          </div>

          <div className="flex gap-3 text-[11px] text-[var(--text-muted)]">
            <span>Aa = <span className="font-mono text-[var(--text)]">{result.Aa}</span></span>
            <span>·</span>
            <span>Av = <span className="font-mono text-[var(--text)]">{result.Av}</span></span>
            <span>·</span>
            <span>Suelo <span className="font-mono text-[var(--text)]">{result.soil_type}</span></span>
            <span>·</span>
            <span>H = <span className="font-mono text-[var(--text)]">{result.total_height_m.toFixed(1)} m</span></span>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]" style={{ height: 440, position: "relative" }}>
            {!plotlyReady && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
                Cargando gráfica…
              </div>
            )}
            <div ref={chartRef} style={{ width: "100%", height: "100%" }} />
          </div>
        </div>
      )}
    </div>
  );
}

function InputChip({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div
      className="rounded-md px-2.5 py-1.5"
      style={{
        background:  ok ? "var(--panel-muted)" : "rgba(239,68,68,0.08)",
        borderLeft: `3px solid ${ok ? "var(--color-success)" : "#ef4444"}`,
      }}
    >
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="font-mono text-[var(--text)]">{value}</div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <span className="font-mono text-sm font-semibold text-[var(--text)]">{value}</span>
    </div>
  );
}

// ── Chart (portado del PerformanceChart de /building) ─────────────────────────
function renderADRSChart(container: HTMLDivElement, data: PerformanceCSMResult, direction: Direction) {
  const Plotly = window.Plotly;
  if (!Plotly) return;

  const { capacity_adrs, demand_elastic, demand_reduced, bilinear_Sd, bilinear_Sa, performance_point: pp, performance_level: pl, total_height_m } = data;

  const cap_Sd  = capacity_adrs.Sd.map((v) => v * 100);
  const dem_e_Sd = demand_elastic.Sd.map((v) => v * 100);
  const dem_r_Sd = demand_reduced.Sd.map((v) => v * 100);
  const bil_Sd  = bilinear_Sd.map((v) => v * 100);
  const pp_Sd   = pp.Sd_pp * 100;

  const driftLimits = [
    { drift_pct: 0.70, label: "IO", color: "#22C55E" },
    { drift_pct: 2.50, label: "LS", color: "#F59E0B" },
    { drift_pct: 5.00, label: "CP", color: "#EF4444" },
  ];

  const saMax = Math.max(
    ...capacity_adrs.Sa,
    ...demand_elastic.Sa.slice(0, Math.ceil(demand_elastic.Sa.length * 0.5)),
  ) * 1.15;

  const sdMax = Math.max(
    ...cap_Sd,
    ...dem_e_Sd.filter((_, i) => demand_elastic.Sd[i] < capacity_adrs.Sd[capacity_adrs.Sd.length - 1] * 1.3),
    pp_Sd * 1.3,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traces: any[] = [];
  let prevSd = 0;
  const bandColors: Record<string, string> = { IO: "#22C55E", LS: "#F59E0B", CP: "#EF4444", C: "#EF4444" };
  for (const lim of driftLimits) {
    const limSd = (lim.drift_pct / 100) * total_height_m * 100;
    traces.push({
      type: "scatter", mode: "none",
      x: [prevSd, limSd, limSd, prevSd, prevSd], y: [0, 0, saMax, saMax, 0],
      fill: "toself", fillcolor: bandColors[lim.label] + "12",
      line: { width: 0 }, name: lim.label, showlegend: false, hoverinfo: "skip",
    });
    traces.push({
      type: "scatter", mode: "lines",
      x: [limSd, limSd], y: [0, saMax],
      line: { color: bandColors[lim.label] + "60", width: 1, dash: "dot" },
      showlegend: false, hoverinfo: "skip",
    });
    prevSd = limSd;
  }

  traces.push({
    type: "scatter", mode: "lines",
    x: dem_e_Sd, y: demand_elastic.Sa,
    name: "Demanda elástica (β=5%)",
    line: { color: "#F59E0B", width: 2 },
    hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Demanda elástica</extra>",
  });
  traces.push({
    type: "scatter", mode: "lines",
    x: dem_r_Sd, y: demand_reduced.Sa,
    name: `Demanda reducida (β=${pp.beta_eff.toFixed(0)}%)`,
    line: { color: "#EF4444", width: 1.5, dash: "dash" },
    hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Demanda reducida</extra>",
  });
  traces.push({
    type: "scatter", mode: "lines",
    x: bil_Sd, y: bilinear_Sa,
    name: "Bilineal idealizada",
    line: { color: "#94A3B8", width: 1.5, dash: "dot" },
    hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Bilineal</extra>",
  });
  traces.push({
    type: "scatter", mode: "lines",
    x: cap_Sd, y: capacity_adrs.Sa,
    name: `Capacidad Dir ${direction}`,
    line: { color: "#3B82F6", width: 2.5 },
    hovertemplate: "Sd=%{x:.1f} cm<br>Sa=%{y:.3f} g<extra>Capacidad</extra>",
  });
  traces.push({
    type: "scatter", mode: "markers+text",
    x: [pp_Sd], y: [pp.Sa_pp], name: "Punto de desempeño",
    marker: { symbol: "star", size: 14, color: pl.color, line: { color: "#fff", width: 1.5 } },
    text: ["PP"], textposition: "top right",
    textfont: { color: pl.color, size: 11, family: "monospace" },
    hovertemplate: `Sd=${pp_Sd.toFixed(1)} cm<br>Sa=${pp.Sa_pp.toFixed(3)} g<br>Deriva=${pp.drift_pp.toFixed(2)}%<extra>PP</extra>`,
  });

  Plotly.react(container, traces, {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor:  "rgba(0,0,0,0)",
    margin: { l: 65, r: 20, t: 30, b: 55 },
    xaxis: {
      title: "Desplazamiento espectral Sd (cm)",
      range: [0, Math.min(sdMax * 1.1, dem_e_Sd[dem_e_Sd.length - 1])],
      gridcolor: "var(--color-border)", zerolinecolor: "var(--color-border)",
      color: "var(--color-text-muted)",
    },
    yaxis: {
      title: "Aceleración espectral Sa (g)",
      range: [0, saMax],
      gridcolor: "var(--color-border)", zerolinecolor: "var(--color-border)",
      color: "var(--color-text-muted)",
    },
    legend: {
      font: { color: "var(--color-text)", size: 10 },
      bgcolor: "rgba(0,0,0,0.4)", bordercolor: "var(--color-border)", borderwidth: 1,
      x: 0.02, y: 0.98, xanchor: "left", yanchor: "top",
    },
    font: { color: "var(--color-text-muted)", size: 11 },
    annotations: [
      { x: (0.35 / 100) * total_height_m * 100, y: saMax * 0.92, text: "IO", showarrow: false, font: { color: "#22C55E", size: 10 } },
      { x: (1.60 / 100) * total_height_m * 100, y: saMax * 0.92, text: "LS", showarrow: false, font: { color: "#F59E0B", size: 10 } },
      { x: (3.75 / 100) * total_height_m * 100, y: saMax * 0.92, text: "CP", showarrow: false, font: { color: "#EF4444", size: 10 } },
    ],
  }, { responsive: true, displaylogo: false, displayModeBar: true });
}
