"use client";

import { useState, useRef, useEffect } from "react";
import type {
  ColumnDesignDetail,
  ColumnReinforcementEdit,
} from "@/lib/structural-types";
import { structuralDesignApi } from "@/lib/structural-api";
import SectionSVG from "./SectionSVG";

// Barras disponibles (mismo catálogo que el engine Python)
const BARS = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"];

interface Props {
  projectId: string;
  data: ColumnDesignDetail;
  onReinforcementSaved?: () => void;
}

type Tab = "info" | "demands" | "section" | "checks";

// ── Check badge ───────────────────────────────────────────────────────────────

function CheckBadge({ ok, label, dcr, ref: refStr }: {
  ok: boolean; label: string; dcr?: number; ref: string;
}) {
  return (
    <div className={`flex items-center justify-between px-3 py-2 rounded border ${
      ok
        ? "border-green-500/30 bg-green-500/5"
        : "border-red-500/30 bg-red-500/10"
    }`}>
      <div>
        <span className="text-xs font-medium text-[var(--foreground)]">{label}</span>
        <span className="ml-2 text-xs text-[var(--muted)]">{refStr}</span>
      </div>
      <div className="flex items-center gap-2">
        {dcr !== undefined && (
          <span className={`text-xs font-mono ${
            dcr > 1.0 ? "text-red-500" : dcr > 0.85 ? "text-amber-500" : "text-green-600"
          }`}>
            DCR {dcr.toFixed(3)}
          </span>
        )}
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
          ok ? "bg-green-500 text-white" : "bg-red-500 text-white"
        }`}>
          {ok ? "✓" : "✕"}
        </span>
      </div>
    </div>
  );
}

// ── Curva P-M inline (Plotly CDN) ─────────────────────────────────────────────

function PMCurveChart({ pmCurve, Pu, Mu }: {
  pmCurve: { P_kN: number[]; M_kNm: number[] };
  Pu: number;
  Mu: number;
}) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const Plotly = (window as Window & { Plotly?: any }).Plotly;
    if (!Plotly || !divRef.current) return;

    const isDark = document.documentElement.classList.contains("dark");
    const bg     = isDark ? "#1a1a1a" : "#ffffff";
    const grid   = isDark ? "#2e2e2e" : "#e5e7eb";
    const text   = isDark ? "#d1d5db" : "#374151";

    Plotly.react(
      divRef.current,
      [
        {
          x: pmCurve.M_kNm,
          y: pmCurve.P_kN,
          mode: "lines",
          name: "Capacidad φP-M",
          line: { color: "#3b82f6", width: 2 },
          fill: "toself",
          fillcolor: "rgba(59,130,246,0.07)",
        },
        {
          x: [Mu],
          y: [Pu],
          mode: "markers",
          name: "Demanda",
          marker: { color: "#ef4444", size: 10, symbol: "x" },
        },
      ],
      {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        margin: { t: 10, r: 10, b: 40, l: 56 },
        xaxis: {
          title: { text: "M (kN·m)", font: { size: 11, color: text } },
          gridcolor: grid, color: text, tickfont: { size: 10 },
        },
        yaxis: {
          title: { text: "P (kN)", font: { size: 11, color: text } },
          gridcolor: grid, color: text, tickfont: { size: 10 },
        },
        legend: { font: { size: 10, color: text }, bgcolor: "transparent" },
        showlegend: true,
      },
      { responsive: true, displayModeBar: false },
    );
  }, [pmCurve, Pu, Mu]);

  return <div ref={divRef} style={{ height: 280, width: "100%" }} />;
}

// ── Panel principal ───────────────────────────────────────────────────────────

export default function ColumnDetailPanel({ projectId, data, onReinforcementSaved }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("section");

  // Estado de edición
  const proposed = data.proposed_reinforcement;
  const userR    = data.final_reinforcement?.reinforcement;

  const [nBars,   setNBars]   = useState<number>(userR?.longitudinal?.n_bars   ?? proposed.longitudinal.n_bars);
  const [barLabel, setBarLabel] = useState<string>(userR?.longitudinal?.bar_label ?? proposed.longitudinal.bar_label);
  const [tieLbl,  setTieLbl]  = useState<string>(userR?.transverse?.tie_bar_label ?? proposed.transverse.tie_bar_label);
  const [sConf,   setSConf]   = useState<number>(userR?.transverse?.s_confined_mm ?? proposed.transverse.s_confined_mm);
  const [sGen,    setSGen]    = useState<number>(userR?.transverse?.s_general_mm  ?? proposed.transverse.s_general_mm);
  const [notes,   setNotes]   = useState(data.final_reinforcement?.notes ?? "");

  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [saveLoading,   setSaveLoading]   = useState(false);
  const [saveOk,        setSaveOk]        = useState(false);
  const [apiError,      setApiError]      = useState<string | null>(null);

  const currentReinforcement: ColumnReinforcementEdit = {
    longitudinal: { n_bars: nBars, bar_label: barLabel },
    transverse:   { tie_bar_label: tieLbl, s_confined_mm: sConf, s_general_mm: sGen },
  };

  // ── Barra de posiciones actualizada cuando cambia n_bars/bar_label ────────
  // Usamos las posiciones del propuesto como referencia visual
  const displayBars = verifyResult?.arrangement?.bar_positions ?? proposed.longitudinal.bar_positions;
  const displayDiam = verifyResult?.arrangement?.diam_mm       ?? proposed.longitudinal.diam_mm;

  async function handleVerify() {
    setVerifyLoading(true);
    setApiError(null);
    try {
      const r = await structuralDesignApi.verifyFrame(projectId, data.frame_id, currentReinforcement);
      setVerifyResult(r);
    } catch (e: any) {
      setApiError(e.message ?? "Error al verificar");
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleSave() {
    setSaveLoading(true);
    setApiError(null);
    try {
      await structuralDesignApi.saveReinforcement(projectId, data.frame_id, currentReinforcement, notes);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
      onReinforcementSaved?.();
    } catch (e: any) {
      setApiError(e.message ?? "Error al guardar");
    } finally {
      setSaveLoading(false);
    }
  }

  const displayChecks = verifyResult?.checks ?? data.checks;
  const displayOk     = verifyResult?.overall_ok ?? data.overall_ok;
  const displayDCR    = verifyResult?.max_dcr    ?? data.max_dcr;

  const TABS: { id: Tab; label: string }[] = [
    { id: "info",    label: "Información" },
    { id: "demands", label: "Demandas" },
    { id: "section", label: "Sección" },
    { id: "checks",  label: "Verificaciones" },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header del frame */}
      <div className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border)] ${
        displayOk ? "bg-green-500/5" : "bg-red-500/5"
      }`}>
        <div>
          <h3 className="text-sm font-bold text-[var(--foreground)]">
            {data.frame_id}
            {data.user_modified && (
              <span className="ml-2 text-xs font-normal text-blue-500">✎ modificado</span>
            )}
          </h3>
          <p className="text-xs text-[var(--muted)]">
            {data.story} · {data.section} · Columna
          </p>
        </div>
        <div className={`flex items-center gap-2 text-sm font-bold ${
          displayOk ? "text-green-600" : "text-red-500"
        }`}>
          DCR {displayDCR.toFixed(3)}
          <span className={`px-2 py-0.5 rounded text-xs ${
            displayOk ? "bg-green-500 text-white" : "bg-red-500 text-white"
          }`}>
            {displayOk ? "CUMPLE" : "NO CUMPLE"}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--border)] bg-[var(--card)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === t.id
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Contenido de tabs */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── TAB: INFORMACIÓN ──────────────────────────────────────────── */}
        {activeTab === "info" && (
          <div className="space-y-4">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-[var(--border)]">
                {[
                  ["Frame", data.frame_id],
                  ["Piso", data.story],
                  ["Sección", data.section],
                  ["b (ancho)", `${(data.geometry.b_m * 100).toFixed(0)} cm`],
                  ["h (alto)", `${(data.geometry.h_m * 100).toFixed(0)} cm`],
                  ["Longitud", `${data.geometry.L_m.toFixed(2)} m`],
                  ["f'c", `${data.geometry.fc_MPa} MPa`],
                  ["fy", `${data.geometry.fy_MPa} MPa`],
                  ["Recubrimiento", `${(data.geometry.cover_m * 100).toFixed(0)} cm`],
                  ["Área bruta (Ag)", `${data.geometry.Ag_cm2.toFixed(0)} cm²`],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="py-1.5 pr-3 text-[var(--muted)] w-40">{k}</td>
                    <td className="py-1.5 font-medium text-[var(--foreground)]">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── TAB: DEMANDAS ──────────────────────────────────────────────── */}
        {activeTab === "demands" && (
          <div className="space-y-4">
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Envolvente (combinación gobernante: {data.demands.governing.combo})
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Pu", data.demands.governing.Pu_kN.toFixed(1), "kN"],
                ["M2", data.demands.governing.Mu2_kNm.toFixed(1), "kN·m"],
                ["M3", data.demands.governing.Mu3_kNm.toFixed(1), "kN·m"],
                ["Mres", data.demands.governing.Mu_res_kNm.toFixed(1), "kN·m"],
                ["V2", data.demands.governing.Vu2_kN.toFixed(1), "kN"],
                ["V3", data.demands.governing.Vu3_kN.toFixed(1), "kN"],
              ].map(([label, val, unit]) => (
                <div key={label} className="bg-[var(--background)] border border-[var(--border)] rounded p-2 text-center">
                  <div className="text-xs text-[var(--muted)]">{label}</div>
                  <div className="text-sm font-bold text-[var(--foreground)]">{val}</div>
                  <div className="text-xs text-[var(--muted)]">{unit}</div>
                </div>
              ))}
            </div>

            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide pt-2">
              Por combinación
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-1 text-left text-[var(--muted)] font-medium pr-2">Combo</th>
                    <th className="pb-1 text-right text-[var(--muted)] font-medium pr-2">Pu (kN)</th>
                    <th className="pb-1 text-right text-[var(--muted)] font-medium pr-2">M2 (kN·m)</th>
                    <th className="pb-1 text-right text-[var(--muted)] font-medium">M3 (kN·m)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]/50">
                  {data.demands.by_combination.map((d) => (
                    <tr key={d.combo_id} className={
                      d.combo_id === data.demands.governing.combo
                        ? "bg-amber-500/10 font-semibold"
                        : ""
                    }>
                      <td className="py-1 pr-2 text-[var(--foreground)]">{d.combo_id}</td>
                      <td className="py-1 pr-2 text-right font-mono">{d.Pu_kN.toFixed(1)}</td>
                      <td className="py-1 pr-2 text-right font-mono">{d.Mu2_kNm.toFixed(1)}</td>
                      <td className="py-1 text-right font-mono">{d.Mu3_kNm.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Curva P-M */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide pt-2">
              Interacción P-M
            </h4>
            <PMCurveChart
              pmCurve={data.pm_curve}
              Pu={data.demands.governing.Pu_kN}
              Mu={data.demands.governing.Mu_res_kNm}
            />
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[var(--background)] border border-[var(--border)] rounded p-2">
                <div className="text-[var(--muted)]">φPn máx.</div>
                <div className="font-mono font-semibold">{data.capacity.phi_Pn_max_kN.toFixed(0)} kN</div>
              </div>
              <div className="bg-[var(--background)] border border-[var(--border)] rounded p-2">
                <div className="text-[var(--muted)]">φMn (flex. pura)</div>
                <div className="font-mono font-semibold">{data.capacity.phi_Mn_kNm.toFixed(0)} kN·m</div>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: SECCIÓN ──────────────────────────────────────────────── */}
        {activeTab === "section" && (
          <div className="space-y-4">
            {/* Diagrama de sección */}
            <div className="flex justify-center">
              <SectionSVG
                b_m={data.geometry.b_m}
                h_m={data.geometry.h_m}
                cover_m={data.geometry.cover_m}
                diam_mm={displayDiam}
                bar_positions={displayBars}
                tie_diam_mm={proposed.transverse.tie_diam_mm}
                showDimensions={true}
                size={280}
              />
            </div>

            {/* Refuerzo requerido vs propuesto */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">
                  Requerido
                </h4>
                <div className="bg-[var(--background)] border border-[var(--border)] rounded p-2 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[var(--muted)]">As long.</span>
                    <span className="font-mono">{data.required_reinforcement.As_long_cm2.toFixed(2)} cm²</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted)]">ρ req.</span>
                    <span className="font-mono">{data.required_reinforcement.rho_req_pct.toFixed(2)}%</span>
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">
                  {data.user_modified ? "Definitivo" : "Propuesto"}
                </h4>
                <div className="bg-[var(--background)] border border-[var(--border)] rounded p-2 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[var(--muted)]">Barras</span>
                    <span className="font-mono">{nBars}{barLabel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted)]">As colocado</span>
                    <span className="font-mono">
                      {verifyResult?.As_placed_cm2?.toFixed(2) ?? proposed.longitudinal.As_placed_cm2.toFixed(2)} cm²
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted)]">ρ</span>
                    <span className="font-mono">
                      {verifyResult?.rho_pct?.toFixed(2) ?? proposed.longitudinal.rho_pct?.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Editor de refuerzo longitudinal */}
            <div className="border border-[var(--border)] rounded p-3 space-y-3 bg-[var(--background)]">
              <h4 className="text-xs font-semibold text-[var(--foreground)]">Refuerzo longitudinal</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">N.º barras</label>
                  <input
                    type="number"
                    min={4}
                    max={20}
                    step={2}
                    value={nBars}
                    onChange={(e) => { setNBars(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Diámetro</label>
                  <select
                    value={barLabel}
                    onChange={(e) => { setBarLabel(e.target.value); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  >
                    {BARS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Editor de estribos */}
            <div className="border border-[var(--border)] rounded p-3 space-y-3 bg-[var(--background)]">
              <h4 className="text-xs font-semibold text-[var(--foreground)]">Refuerzo transversal</h4>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Estribo</label>
                  <select
                    value={tieLbl}
                    onChange={(e) => { setTieLbl(e.target.value); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  >
                    {["#3","#4","#5"].map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">s conf. (mm)</label>
                  <input
                    type="number" min={50} max={300} step={10} value={sConf}
                    onChange={(e) => { setSConf(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">s general (mm)</label>
                  <input
                    type="number" min={50} max={400} step={10} value={sGen}
                    onChange={(e) => { setSGen(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                <div>Lc confinamiento: {proposed.transverse.L_confinement_mm.toFixed(0)} mm</div>
                <div>n ramas b: {proposed.transverse.n_legs_b} · n ramas h: {proposed.transverse.n_legs_h}</div>
              </div>
            </div>

            {/* Notas */}
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Notas del ingeniero</label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Observaciones sobre el diseño definitivo..."
                className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)] resize-none"
              />
            </div>

            {/* Error de API */}
            {apiError && (
              <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">
                {apiError}
              </div>
            )}

            {/* Resultado de verificación */}
            {verifyResult && (
              <div className={`text-xs rounded p-2 border ${
                verifyResult.overall_ok
                  ? "bg-green-500/10 border-green-500/30 text-green-700"
                  : "bg-red-500/10 border-red-500/30 text-red-600"
              }`}>
                {verifyResult.overall_ok ? "✓ CUMPLE" : "✕ NO CUMPLE"} · DCR {verifyResult.max_dcr?.toFixed(3)}
                {verifyResult.errors?.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-red-600">
                    {verifyResult.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
                  </ul>
                )}
                {verifyResult.warnings?.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-amber-600">
                    {verifyResult.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* Botones de acción */}
            <div className="flex gap-2">
              <button
                onClick={handleVerify}
                disabled={verifyLoading}
                className="flex-1 py-2 text-xs font-semibold border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-50"
              >
                {verifyLoading ? "Verificando..." : "↺ Verificar"}
              </button>
              <button
                onClick={handleSave}
                disabled={saveLoading}
                className={`flex-1 py-2 text-xs font-semibold rounded transition-colors disabled:opacity-50 ${
                  saveOk
                    ? "bg-green-500 text-white"
                    : "bg-[var(--accent)] text-white hover:opacity-90"
                }`}
              >
                {saveLoading ? "Guardando..." : saveOk ? "✓ Guardado" : "Guardar definitivo"}
              </button>
            </div>
          </div>
        )}

        {/* ── TAB: VERIFICACIONES ─────────────────────────────────────── */}
        {activeTab === "checks" && (
          <div className="space-y-2">
            <div className={`flex items-center gap-2 text-sm font-semibold p-2 rounded ${
              displayOk ? "text-green-600" : "text-red-500"
            }`}>
              {displayOk ? "✓ Todas las verificaciones cumplen" : "✕ Hay verificaciones que no cumplen"}
              <span className="text-xs font-mono">DCR max = {displayDCR.toFixed(3)}</span>
            </div>

            {Object.entries(displayChecks).map(([key, chk]: [string, any]) => {
              const labels: Record<string, string> = {
                pm_interaction: "Interacción P-M",
                rho_min:        "Cuantía mínima ρ_min",
                rho_max:        "Cuantía máxima ρ_max",
                as_placed:      "Acero colocado ≥ requerido",
                shear:          "Cortante",
              };
              return (
                <CheckBadge
                  key={key}
                  ok={chk.ok}
                  label={labels[key] ?? key}
                  dcr={chk.dcr}
                  ref={chk.ref ?? "NSR-10"}
                />
              );
            })}

            {/* Estribos propuestos */}
            <div className="mt-4 border border-[var(--border)] rounded p-3 space-y-1 text-xs">
              <h4 className="font-semibold text-[var(--foreground)] mb-2">Estribos</h4>
              {[
                ["Estribo", `${proposed.transverse.tie_bar_label}`],
                ["Zona confinada s", `${proposed.transverse.s_confined_mm} mm`],
                ["Zona general s", `${proposed.transverse.s_general_mm} mm`],
                ["Long. confinamiento", `${proposed.transverse.L_confinement_mm.toFixed(0)} mm`],
                ["Ramas en b", `${proposed.transverse.n_legs_b}`],
                ["Ramas en h", `${proposed.transverse.n_legs_h}`],
                ["φVc", `${proposed.transverse.phi_Vc_kN.toFixed(1)} kN`],
                ["Nivel ductilidad", proposed.transverse.energy_dissipation],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-[var(--muted)]">{k}</span>
                  <span className="font-mono">{v}</span>
                </div>
              ))}
            </div>

            {/* Advertencias */}
            {data.warnings.length > 0 && (
              <div className="border border-amber-400/30 bg-amber-500/5 rounded p-2 space-y-1">
                <div className="text-xs font-semibold text-amber-600">⚠ Advertencias</div>
                {data.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-700">{w}</div>
                ))}
              </div>
            )}
            {data.errors.length > 0 && (
              <div className="border border-red-400/30 bg-red-500/5 rounded p-2 space-y-1">
                <div className="text-xs font-semibold text-red-600">✕ Errores</div>
                {data.errors.map((e, i) => (
                  <div key={i} className="text-xs text-red-700">{e}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
