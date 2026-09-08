"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useTheme } from "@/lib/theme";
import { wallDesignApi } from "@/lib/wall-api";
import { ApiError } from "@/lib/api";
import type {
  WallDesignRequest,
  WallDesignResult,
  WallDesignDemand,
  WallDuctility,
  WallDesignMode,
} from "@/lib/wall-types";

// ── Shared styles ─────────────────────────────────────────────────────────────
const card = "rounded-xl border border-[var(--border)] bg-[var(--surface)]";
const inp  = "w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none focus:border-indigo-500";
const lbl  = "text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide";
const btnP = "px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 transition-colors";
const btnS = "px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors";

type ResultTab = "pm" | "shear" | "ebe" | "checks";

const RESULT_TABS: { id: ResultTab; label: string }[] = [
  { id: "pm",     label: "Diagrama P-M" },
  { id: "shear",  label: "Cortante" },
  { id: "ebe",    label: "Elemento de Borde" },
  { id: "checks", label: "Revisión NSR-10" },
];

const DEFAULT_DEMANDS: WallDesignDemand[] = [
  { label: "1.4D",            Pu_kN: 2000, Vu_kN: 0,   Mu_kNm: 0,    is_seismic: false },
  { label: "1.2D+1.0E+1.0L",  Pu_kN: 1500, Vu_kN: 800, Mu_kNm: 3500, is_seismic: true  },
  { label: "0.9D+1.0E",       Pu_kN: 900,  Vu_kN: 800, Mu_kNm: 3500, is_seismic: true  },
];

// ── Wall section SVG ──────────────────────────────────────────────────────────

function WallSectionSVG({
  result,
  lw_m,
  tw_m,
}: {
  result: WallDesignResult | null;
  lw_m: number;
  tw_m: number;
}) {
  const W    = 440;
  const H    = 160;
  const PAD  = 20;
  const wallW = W - 2 * PAD;
  const wallH = H - 2 * PAD;
  const wallX = PAD;
  const wallY = PAD;
  const scale = wallW / lw_m; // px/m

  const bars   = result?.bars ?? [];
  const c_m    = result?.neutral_axis.c_m ?? null;
  const lc_m   = result?.boundary_element.lc_m ?? 0;
  const beReq  = result?.boundary_element.required ?? false;

  const cx = (x_m: number) => wallX + x_m * scale;
  const barR = Math.max(3, Math.min(7, (bars[0]?.As ?? 200) / 100));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="rounded-lg border border-[var(--border)]">
      {/* Wall outline */}
      <rect x={wallX} y={wallY} width={wallW} height={wallH}
        fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />

      {/* EBE zones */}
      {beReq && lc_m > 0 && (
        <>
          <rect x={wallX} y={wallY} width={lc_m * scale} height={wallH}
            fill="#6366f122" stroke="#6366f1" strokeWidth={1} strokeDasharray="3,2" />
          <rect x={cx(lw_m - lc_m)} y={wallY} width={lc_m * scale} height={wallH}
            fill="#6366f122" stroke="#6366f1" strokeWidth={1} strokeDasharray="3,2" />
          <text x={wallX + lc_m * scale / 2} y={wallY + wallH + 14}
            textAnchor="middle" fontSize={9} fill="#6366f1">
            lc={lc_m.toFixed(2)}m
          </text>
          <text x={cx(lw_m - lc_m) + lc_m * scale / 2} y={wallY + wallH + 14}
            textAnchor="middle" fontSize={9} fill="#6366f1">
            lc={lc_m.toFixed(2)}m
          </text>
        </>
      )}

      {/* Compression zone */}
      {c_m !== null && (
        <rect x={wallX} y={wallY} width={Math.min(c_m * scale, wallW)} height={wallH}
          fill="#0e7fa808" />
      )}

      {/* Neutral axis line */}
      {c_m !== null && c_m < lw_m && (
        <>
          <line x1={cx(c_m)} y1={wallY - 5} x2={cx(c_m)} y2={wallY + wallH + 5}
            stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
          <text x={cx(c_m)} y={wallY - 8} textAnchor="middle" fontSize={9} fill="#f59e0b">
            c={c_m.toFixed(2)}m
          </text>
        </>
      )}

      {/* Steel bars */}
      {bars.map((b, i) => (
        <circle key={i} cx={cx(b.x)} cy={wallY + wallH / 2}
          r={barR} fill="#94a3b8" stroke="#64748b" strokeWidth={0.8} />
      ))}

      {/* Dimension line */}
      <line x1={wallX} y1={wallY + wallH + 22} x2={wallX + wallW} y2={wallY + wallH + 22}
        stroke="var(--text-muted)" strokeWidth={0.8} />
      <text x={wallX + wallW / 2} y={wallY + wallH + 32}
        textAnchor="middle" fontSize={9} fill="var(--text-muted)">
        lw = {lw_m.toFixed(2)} m
      </text>

      {/* tw label */}
      <text x={W - 5} y={wallY + wallH / 2 + 4}
        textAnchor="end" fontSize={8} fill="var(--text-muted)">
        tw={tw_m.toFixed(2)}m
      </text>
    </svg>
  );
}

// ── P-M Interaction chart ─────────────────────────────────────────────────────

function PMChart({ result, isDark }: { result: WallDesignResult; isDark: boolean }) {
  const ref   = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(
    typeof window !== "undefined" && !!(window as unknown as { Plotly?: unknown }).Plotly,
  );

  useEffect(() => {
    if ((window as unknown as { Plotly?: unknown }).Plotly) { setReady(true); return; }
    const s  = document.createElement("script");
    s.src    = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!ready || !ref.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any).Plotly as Record<string, (...a: unknown[]) => unknown>;

    const bg   = isDark ? "#0f172a" : "#ffffff";
    const grid = isDark ? "#1e293b" : "#f1f5f9";
    const txt  = isDark ? "#94a3b8" : "#64748b";

    const diag = result.interaction;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [
      {
        x: diag.Mn_kNm, y: diag.Pn_kN,
        name: "Pn nominal", mode: "lines",
        line: { color: "#64748b", width: 1, dash: "dot" },
      },
      {
        x: diag.phiMn_kNm, y: diag.phiPn_kN,
        name: "φPn reducida", mode: "lines",
        line: { color: "#6366f1", width: 2 },
        fill: "tozeroy", fillcolor: "#6366f110",
      },
    ];

    const inside_pts  = result.demand_points.filter(p => p.inside);
    const outside_pts = result.demand_points.filter(p => !p.inside);

    if (inside_pts.length > 0) {
      traces.push({
        x: inside_pts.map(p => p.Mu_kNm),
        y: inside_pts.map(p => p.Pu_kN),
        text: inside_pts.map(p => p.label),
        mode: "markers+text", textposition: "top center",
        marker: { color: "#22c55e", size: 10, symbol: "diamond" },
        name: "Demanda OK",
      });
    }
    if (outside_pts.length > 0) {
      traces.push({
        x: outside_pts.map(p => p.Mu_kNm),
        y: outside_pts.map(p => p.Pu_kN),
        text: outside_pts.map(p => p.label),
        mode: "markers+text", textposition: "top center",
        marker: { color: "#ef4444", size: 10, symbol: "x" },
        name: "Demanda NO OK",
      });
    }

    Plotly.react(ref.current, traces, {
      paper_bgcolor: bg, plot_bgcolor: bg,
      margin: { t: 20, r: 20, b: 50, l: 70 },
      xaxis: {
        title: { text: "Momento (kN·m)", font: { size: 11, color: txt } },
        gridcolor: grid, color: txt, rangemode: "tozero",
      },
      yaxis: {
        title: { text: "Carga axial P (kN)", font: { size: 11, color: txt } },
        gridcolor: grid, color: txt,
      },
      legend: { font: { size: 10, color: txt }, bgcolor: "transparent" },
      showlegend: true,
    }, { responsive: true, displayModeBar: false });
  }, [result, isDark, ready]);

  return <div ref={ref} style={{ height: 380 }} />;
}

// ── Field input component ─────────────────────────────────────────────────────

function Field({
  label, value, onChange, step = 0.01, unit = "",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  unit?: string;
}) {
  return (
    <div>
      <p className={lbl + " mb-0.5"}>{label}{unit ? ` (${unit})` : ""}</p>
      <input
        type="number"
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={inp}
      />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WallDesignPage() {
  const ready       = useRequireAuth();
  const { theme }   = useTheme();
  const isDark      = theme === "dark";

  // Form state
  const [lw, setLw]     = useState(5.0);
  const [tw, setTw]     = useState(0.25);
  const [hw, setHw]     = useState(12.0);
  const [fc, setFc]     = useState(28.0);
  const [fy, setFy]     = useState(420.0);
  const [fyt, setFyt]   = useState(420.0);
  const [duct, setDuct] = useState<WallDuctility>("DES");
  const [mode, setMode] = useState<WallDesignMode>("auto");
  const [drift, setDrift] = useState<string>("");
  const [cover, setCover] = useState(40.0);
  const [demands, setDemands] = useState<WallDesignDemand[]>(DEFAULT_DEMANDS);

  // Results
  const [result, setResult]     = useState<WallDesignResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("pm");

  if (!ready) return null;

  // Run design
  async function runDesign() {
    setLoading(true);
    setError(null);
    try {
      const req: WallDesignRequest = {
        lw_m: lw, tw_m: tw, hw_m: hw,
        fc_mpa: fc, fy_mpa: fy, fyt_mpa: fyt,
        ductility: duct,
        demands,
        mode,
        cover_mm: cover,
        delta_u_hw: drift ? parseFloat(drift) : undefined,
      };
      const res = await wallDesignApi.compute(req);
      setResult(res);
      setResultTab("pm");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error en el cálculo");
    } finally {
      setLoading(false);
    }
  }

  // Demand table helpers
  function updateDemand(i: number, field: keyof WallDesignDemand, val: string | boolean | number) {
    setDemands(prev => prev.map((d, j) => j === i ? { ...d, [field]: val } : d));
  }
  function addDemand() {
    setDemands(prev => [
      ...prev,
      { label: `Combo ${prev.length + 1}`, Pu_kN: 0, Vu_kN: 0, Mu_kNm: 0, is_seismic: true },
    ]);
  }
  function removeDemand(i: number) {
    setDemands(prev => prev.filter((_, j) => j !== i));
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader />

      <main className="mx-auto max-w-7xl px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Diseño de Muros RC</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              NSR-10 / ACI 318-25 — Secciones rectangulares — DMO / DES
            </p>
          </div>
          {result && (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold ${
              result.ok
                ? "bg-green-500/10 text-green-400"
                : "bg-red-500/10 text-red-400"
            }`}>
              {result.ok
                ? "Diseno OK"
                : `${result.summary.failed_checks} verificaciones fallan`}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Panel izquierdo: inputs */}
          <div className="flex flex-col gap-4">

            {/* Geometria */}
            <div className={card + " p-4"}>
              <p className="text-xs font-semibold text-[var(--text)] mb-3">Geometria del muro</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Longitud lw" value={lw} onChange={setLw} step={0.1} unit="m" />
                <Field label="Espesor tw"  value={tw} onChange={setTw} step={0.05} unit="m" />
                <Field label="Altura hw"   value={hw} onChange={setHw} step={0.5} unit="m" />
                <Field label="Recubrimiento" value={cover} onChange={setCover} step={5} unit="mm" />
              </div>
            </div>

            {/* Materiales */}
            <div className={card + " p-4"}>
              <p className="text-xs font-semibold text-[var(--text)] mb-3">Materiales</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="f'c"       value={fc}  onChange={setFc}  step={1}  unit="MPa" />
                <Field label="fy long."  value={fy}  onChange={setFy}  step={10} unit="MPa" />
                <Field label="fyt trans." value={fyt} onChange={setFyt} step={10} unit="MPa" />
              </div>
            </div>

            {/* Ductilidad y modo */}
            <div className={card + " p-4"}>
              <p className="text-xs font-semibold text-[var(--text)] mb-3">Nivel de disipacion y modo</p>

              <p className={lbl + " mb-1"}>Ductilidad</p>
              <div className="flex gap-2 mb-3">
                {(["DES", "DMO"] as WallDuctility[]).map(d => (
                  <button key={d} onClick={() => setDuct(d)}
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                      duct === d
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-400"
                        : "border-[var(--border)] text-[var(--text-muted)]"
                    }`}>
                    {d}
                  </button>
                ))}
              </div>

              <p className={lbl + " mb-1"}>Modo de diseno</p>
              <div className="flex gap-2 mb-3">
                {(["auto", "manual"] as WallDesignMode[]).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                      mode === m
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-400"
                        : "border-[var(--border)] text-[var(--text-muted)]"
                    }`}>
                    {m === "auto" ? "Automatico" : "Manual"}
                  </button>
                ))}
              </div>

              {duct === "DES" && (
                <div>
                  <p className={lbl + " mb-0.5"}>Deriva de diseno du/hw (opcional)</p>
                  <input
                    type="number" step={0.001} value={drift}
                    onChange={e => setDrift(e.target.value)}
                    placeholder="ej. 0.010"
                    className={inp}
                  />
                  <p className="text-[9px] text-[var(--text-muted)] mt-0.5">
                    Si se omite, usa metodo de esfuerzo para EBE
                  </p>
                </div>
              )}
            </div>

            {/* Calcular */}
            <button
              onClick={runDesign}
              disabled={loading || demands.length === 0}
              className={btnP + " w-full"}>
              {loading ? "Calculando..." : "Calcular diseno"}
            </button>

            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>

          {/* Panel centro: seccion + resumen */}
          <div className="flex flex-col gap-4">

            {/* Seccion visual */}
            <div className={card + " p-4"}>
              <p className="text-xs font-semibold text-[var(--text)] mb-3">
                Seccion transversal
                {result?.boundary_element.required && (
                  <span className="ml-2 text-[10px] font-normal text-indigo-400">
                    EBE requerido —{" "}
                    {result.boundary_element.method === "displacement"
                      ? "metodo deformacion"
                      : "metodo esfuerzo"}
                  </span>
                )}
              </p>
              <WallSectionSVG result={result} lw_m={lw} tw_m={tw} />

              {result && (
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[9px] text-[var(--text-muted)] uppercase">Eje neutro c</p>
                    <p className="text-xs font-semibold text-amber-400">
                      {result.neutral_axis.c_m.toFixed(3)} m
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-[var(--text-muted)] uppercase">Long. EBE</p>
                    <p className="text-xs font-semibold text-indigo-400">
                      {result.boundary_element.required
                        ? result.boundary_element.lc_m.toFixed(3) + " m"
                        : "No req."}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-[var(--text-muted)] uppercase">phi factor</p>
                    <p className="text-xs font-semibold text-[var(--text)]">
                      {result.neutral_axis.phi.toFixed(2)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Resumen refuerzo */}
            {result && (
              <div className={card + " p-4"}>
                <p className="text-xs font-semibold text-[var(--text)] mb-3">Refuerzo propuesto</p>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-muted)]">EBE (vert.)</span>
                    <span className="font-medium text-[var(--text)]">
                      {result.reinforcement.be_left.n_bars}
                      {"-O"}{result.reinforcement.be_left.db_mm.toFixed(1)}mm
                      c/{result.reinforcement.be_left.tie_spacing_mm.toFixed(0)}mm
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-muted)]">Alma horizontal</span>
                    <span className="font-medium text-[var(--text)]">
                      O{result.reinforcement.web.horiz_db_mm.toFixed(1)}
                      @{result.reinforcement.web.horiz_spacing_mm.toFixed(0)}mm
                      (rho={(result.reinforcement.web.rho_h * 100).toFixed(3)}%)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-muted)]">Alma vertical</span>
                    <span className="font-medium text-[var(--text)]">
                      O{result.reinforcement.web.vert_db_mm.toFixed(1)}
                      @{result.reinforcement.web.vert_spacing_mm.toFixed(0)}mm
                      (rho={(result.reinforcement.web.rho_v * 100).toFixed(3)}%)
                    </span>
                  </div>
                  {result.confinement && (
                    <div className="flex justify-between">
                      <span className="text-[var(--text-muted)]">Confinamiento EBE</span>
                      <span className={`font-medium ${result.confinement.ok_ash ? "text-green-400" : "text-red-400"}`}>
                        Ash={result.confinement.Ash_prov_mm2.toFixed(0)}
                        &ge;{result.confinement.Ash_req_mm2.toFixed(0)} mm²
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Panel derecho: tabla de demandas */}
          <div className={card + " p-4"}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-[var(--text)]">
                Combinaciones de carga ({demands.length})
              </p>
              <button onClick={addDemand} className={btnS + " text-[10px]"}>+ Agregar</button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-1 text-left text-[var(--text-muted)] font-medium">Combo</th>
                    <th className="pb-1 text-right text-[var(--text-muted)] font-medium">Pu (kN)</th>
                    <th className="pb-1 text-right text-[var(--text-muted)] font-medium">Vu (kN)</th>
                    <th className="pb-1 text-right text-[var(--text-muted)] font-medium">Mu (kN.m)</th>
                    <th className="pb-1 text-center text-[var(--text-muted)] font-medium">Sism.</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {demands.map((d, i) => (
                    <tr key={i} className="group">
                      <td className="py-1 pr-1">
                        <input
                          value={d.label}
                          onChange={e => updateDemand(i, "label", e.target.value)}
                          className="w-full bg-transparent text-[var(--text)] focus:outline-none text-[10px]"
                        />
                      </td>
                      {(["Pu_kN", "Vu_kN", "Mu_kNm"] as const).map(f => (
                        <td key={f} className="py-1 px-1">
                          <input
                            type="number" step={10} value={d[f] as number}
                            onChange={e => updateDemand(i, f, parseFloat(e.target.value) || 0)}
                            className="w-16 bg-transparent text-right text-[var(--text)] focus:outline-none text-[10px]"
                          />
                        </td>
                      ))}
                      <td className="py-1 text-center">
                        <input
                          type="checkbox" checked={d.is_seismic}
                          onChange={e => updateDemand(i, "is_seismic", e.target.checked)}
                        />
                      </td>
                      <td className="py-1 pl-1">
                        <button
                          onClick={() => removeDemand(i)}
                          className="text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                          x
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Demand points status */}
            {result && (
              <div className="mt-4 space-y-1">
                {result.demand_points.map((pt, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px]">
                    <span className="text-[var(--text-muted)]">{pt.label}</span>
                    <span className={pt.inside ? "text-green-400" : "text-red-400"}>
                      {pt.inside ? "Dentro" : "Fuera"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Paneles de resultados */}
        {result && (
          <div className={card + " mt-6"}>
            {/* Tabs */}
            <div className="flex border-b border-[var(--border)]">
              {RESULT_TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setResultTab(t.id)}
                  className={`px-5 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                    resultTab === t.id
                      ? "border-indigo-500 text-indigo-400"
                      : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="p-4">

              {/* Tab: P-M Diagram */}
              {resultTab === "pm" && <PMChart result={result} isDark={isDark} />}

              {/* Tab: Shear */}
              {resultTab === "shear" && (
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs font-semibold text-[var(--text)] mb-3">Parametros de cortante</p>
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-[var(--border)]">
                        {([
                          ["hw/lw",                           result.shear.hw_lw.toFixed(2),             ""],
                          ["alfa_c",                          result.shear.alpha_c.toFixed(3),           ""],
                          ["Acv",                             result.shear.Acv_m2.toFixed(3),            "m²"],
                          ["Vu diseno",                       result.shear.Vu_kN.toFixed(0),             "kN"],
                          ["phiVn provista",                  result.shear.phi_Vn_kN.toFixed(0),         "kN"],
                          ["Vn limite (0.83*sqrt(f'c)*Acv)", result.shear.Vn_limit_kN.toFixed(0),       "kN"],
                          ["rho_h requerida",                 (result.shear.rho_t_req * 100).toFixed(3), "%"],
                          ["rho_h provista",                  (result.shear.rho_t_prov * 100).toFixed(3),"%"],
                          ["rho_v provista",                  (result.shear.rho_v_prov * 100).toFixed(3),"%"],
                        ] as [string, string, string][]).map(([k, v, u]) => (
                          <tr key={k}>
                            <td className="py-1.5 text-[var(--text-muted)]">{k}</td>
                            <td className="py-1.5 text-right font-medium text-[var(--text)]">{v} {u}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[var(--text)] mb-3">Estado</p>
                    {[
                      { label: "phiVn >= Vu",         ok: result.shear.ok_shear },
                      { label: "rho_h >= rho_h_req",  ok: result.shear.ok_rho_t },
                      { label: "rho_v >= 0.0025",     ok: result.shear.ok_rho_v },
                      { label: "Vn <= 0.83*sqrt(f'c)*Acv", ok: result.shear.ok_vn_limit },
                    ].map(({ label, ok }) => (
                      <div key={label}
                        className={`flex items-center gap-2 py-1.5 text-xs ${ok ? "text-green-400" : "text-red-400"}`}>
                        <span>{ok ? "OK" : "NO"}</span>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tab: EBE */}
              {resultTab === "ebe" && (
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs font-semibold text-[var(--text)] mb-3">Eje neutro y elemento de borde</p>
                    <div className="space-y-2 text-xs">
                      <div className="p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                        <p className="text-[10px] text-[var(--text-muted)] uppercase mb-1">
                          Eje neutro (combo gobernante: {result.governing_combo})
                        </p>
                        <p className="font-semibold text-[var(--text)]">
                          c = {result.neutral_axis.c_m.toFixed(3)} m
                        </p>
                        <p className="text-[var(--text-muted)]">
                          a = beta1*c = {result.neutral_axis.a_m.toFixed(3)} m
                          (beta1 = {result.neutral_axis.beta1.toFixed(3)})
                        </p>
                        <p className="text-[var(--text-muted)]">
                          phi = {result.neutral_axis.phi.toFixed(2)}
                        </p>
                      </div>
                      <div className={`p-3 rounded-lg border ${
                        result.boundary_element.required
                          ? "bg-indigo-500/5 border-indigo-500/30"
                          : "bg-green-500/5 border-green-500/30"
                      }`}>
                        <p className="text-[10px] text-[var(--text-muted)] uppercase mb-1">
                          Elemento de borde — Metodo{" "}
                          {result.boundary_element.method === "displacement" ? "Deformacion" : "Esfuerzo"}
                        </p>
                        <p className={`font-semibold ${result.boundary_element.required ? "text-indigo-400" : "text-green-400"}`}>
                          {result.boundary_element.required ? "EBE REQUERIDO" : "EBE no requerido"}
                        </p>
                        <p className="text-[var(--text-muted)] mt-1">{result.boundary_element.message}</p>
                        {result.boundary_element.required && (
                          <p className="mt-1 font-medium text-[var(--text)]">
                            lc = {result.boundary_element.lc_m.toFixed(3)} m
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[var(--text)] mb-3">Confinamiento EBE</p>
                    {result.confinement ? (
                      <div className="space-y-2 text-xs">
                        {([
                          ["Ash requerida",  result.confinement.Ash_req_mm2.toFixed(1) + " mm²"],
                          ["Ash provista",   result.confinement.Ash_prov_mm2.toFixed(1) + " mm²"],
                          ["s adoptado",     result.confinement.s_mm.toFixed(0) + " mm"],
                          ["s max. codigo",  result.confinement.s_max_code_mm.toFixed(0) + " mm"],
                        ] as [string, string][]).map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-[var(--text-muted)]">{k}</span>
                            <span className="font-medium text-[var(--text)]">{v}</span>
                          </div>
                        ))}
                        <p className="text-[9px] text-[var(--text-muted)] mt-2 border-t border-[var(--border)] pt-2">
                          {result.confinement.message}
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--text-muted)]">Confinamiento especial no requerido</p>
                    )}
                  </div>
                </div>
              )}

              {/* Tab: NSR-10 Checks */}
              {resultTab === "checks" && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[10px] text-[var(--text-muted)]">
                        <th className="pb-2 text-left font-medium">Articulo</th>
                        <th className="pb-2 text-left font-medium">Descripcion</th>
                        <th className="pb-2 text-right font-medium">Demanda</th>
                        <th className="pb-2 text-right font-medium">Capacidad</th>
                        <th className="pb-2 text-right font-medium">DCR</th>
                        <th className="pb-2 text-center font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {result.checks.map((c, i) => (
                        <tr key={i} className={c.ok ? "" : "bg-red-500/5"}>
                          <td className="py-2 text-[var(--text-muted)] text-[10px] pr-3">{c.article}</td>
                          <td className="py-2 text-[var(--text)]">{c.description}</td>
                          <td className="py-2 text-right text-[var(--text)]">
                            {typeof c.demand === "number" ? c.demand.toFixed(3) : c.demand} {c.unit}
                          </td>
                          <td className="py-2 text-right text-[var(--text)]">
                            {typeof c.capacity === "number" ? c.capacity.toFixed(3) : c.capacity} {c.unit}
                          </td>
                          <td className={`py-2 text-right font-semibold ${c.dcr <= 1 ? "text-green-400" : "text-red-400"}`}>
                            {c.dcr.toFixed(3)}
                          </td>
                          <td className="py-2 text-center text-base">
                            {c.ok ? "OK" : "NO"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            </div>
          </div>
        )}

      </main>
    </div>
  );
}
