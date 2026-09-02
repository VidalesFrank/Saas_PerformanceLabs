"use client";

import { useState } from "react";
import type {
  BeamDesignDetail,
  BeamReinforcementEdit,
} from "@/lib/structural-types";
import { structuralDesignApi } from "@/lib/structural-api";
import SectionSVG from "./SectionSVG";

const BARS    = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"];
const TIE_BARS = ["#3", "#4", "#5"];

interface Props {
  projectId: string;
  data: BeamDesignDetail;
  onReinforcementSaved?: () => void;
}

type Tab = "info" | "demands" | "reinforcement" | "checks";

// ── Badge de verificación ─────────────────────────────────────────────────────

function CheckBadge({ ok, label, dcr, ref: refStr }: {
  ok: boolean; label: string; dcr?: number; ref: string;
}) {
  return (
    <div className={`flex items-center justify-between px-3 py-2 rounded border ${
      ok ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/10"
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

// ── Diagrama de momentos SVG inline ──────────────────────────────────────────

function MomentDiagram({ data }: { data: BeamDesignDetail }) {
  const zones = data.demands.by_zone;
  const L = data.geometry.L_m;

  // Puntos: [0, L/3, L/2, 2L/3, L] con demandas
  const Mneg_i   = zones.end_i?.Mu_neg_kNm  ?? 0;
  const Mpos_mid = zones.mid?.Mu_pos_kNm     ?? 0;
  const Mneg_j   = zones.end_j?.Mu_neg_kNm  ?? 0;

  const maxM = Math.max(Mneg_i, Mpos_mid, Mneg_j, 0.1);

  const W = 320;
  const H = 140;
  const mx = 30;
  const my = 20;

  const drawW = W - 2 * mx;
  const drawH = H - 2 * my;

  // Línea de eje
  const axisY = my + drawH * 0.5;

  // Escala
  const scaleM = (drawH * 0.42) / maxM;

  const x0 = mx;
  const x1 = mx + drawW * 0.33;
  const x2 = mx + drawW * 0.5;
  const x3 = mx + drawW * 0.67;
  const x4 = mx + drawW;

  // Momentos negativos van hacia arriba; positivos hacia abajo
  const yNegI   = axisY - Mneg_i   * scaleM;
  const yPosMid = axisY + Mpos_mid * scaleM;
  const yNegJ   = axisY - Mneg_j   * scaleM;
  const yZero   = axisY;

  const pathD = `M ${x0} ${yNegI} L ${x1} ${yZero} L ${x2} ${yPosMid} L ${x3} ${yZero} L ${x4} ${yNegJ}`;
  const fillD = `${pathD} L ${x4} ${axisY} L ${x0} ${axisY} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: 150 }}>
      {/* Eje */}
      <line x1={mx} y1={axisY} x2={mx + drawW} y2={axisY}
        stroke="#888" strokeWidth={1} strokeDasharray="4 3" />

      {/* Relleno diagrama */}
      <path d={fillD} fill="rgba(59,130,246,0.12)" />

      {/* Línea diagrama */}
      <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} />

      {/* Valores */}
      <text x={x0} y={yNegI - 4} textAnchor="middle" fontSize={9} fill="#3b82f6">
        {Mneg_i.toFixed(0)}
      </text>
      <text x={x2} y={yPosMid + 12} textAnchor="middle" fontSize={9} fill="#3b82f6">
        {Mpos_mid.toFixed(0)}
      </text>
      <text x={x4} y={yNegJ - 4} textAnchor="end" fontSize={9} fill="#3b82f6">
        {Mneg_j.toFixed(0)}
      </text>

      {/* Etiquetas de zona */}
      <text x={x0 + 20} y={my + 10} fontSize={8} fill="#888">Ext. I</text>
      <text x={x2} y={my + 10} textAnchor="middle" fontSize={8} fill="#888">Centro</text>
      <text x={x4 - 20} y={my + 10} textAnchor="end" fontSize={8} fill="#888">Ext. J</text>

      {/* Unidades */}
      <text x={mx} y={H - 4} fontSize={8} fill="#888">kN·m · (−) superior · (+) inferior</text>
    </svg>
  );
}

// ── Vista longitudinal de barras SVG ─────────────────────────────────────────

function LongitudinalView({ data }: { data: BeamDesignDetail }) {
  const prop = data.proposed_reinforcement;
  const L    = data.geometry.L_m;

  const W  = 320;
  const H  = 100;
  const mx = 20;
  const barH = 12;

  const beamTop    = 35;
  const beamBottom = 75;
  const beamLeft   = mx;
  const beamRight  = W - mx;
  const drawL      = beamRight - beamLeft;

  const Lext  = prop.top_extra_i.L_m > 0 ? prop.top_extra_i.L_m / L * drawL : 0;
  const LextJ = prop.top_extra_j.L_m > 0 ? prop.top_extra_j.L_m / L * drawL : 0;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: 110 }}>
      {/* Perfil de la viga */}
      <rect x={beamLeft} y={beamTop} width={drawL} height={beamBottom - beamTop}
        fill="#e8e0d0" stroke="#666" strokeWidth={1} />

      {/* Barras superiores continuas (color azul oscuro) */}
      <rect x={beamLeft + 4} y={beamTop + 4} width={drawL - 8} height={barH}
        fill="#1e3a5f" rx={2} />
      <text x={mx + drawL / 2} y={beamTop + 12} textAnchor="middle" fontSize={8} fill="white">
        {prop.top_continuous.n_bars}{prop.top_continuous.bar_label} corridas
      </text>

      {/* Barras adicionales extremo I */}
      {prop.top_extra_i.n_bars > 0 && Lext > 10 && (
        <>
          <rect x={beamLeft + 4} y={beamTop + 4 + barH + 2} width={Lext - 4} height={barH - 2}
            fill="#2563eb" rx={2} />
          <text x={beamLeft + 4 + (Lext - 4) / 2} y={beamTop + 4 + barH + 11}
            textAnchor="middle" fontSize={7} fill="white">
            +{prop.top_extra_i.n_bars}{prop.top_extra_i.bar_label}
          </text>
        </>
      )}

      {/* Barras adicionales extremo J */}
      {prop.top_extra_j.n_bars > 0 && LextJ > 10 && (
        <>
          <rect x={beamRight - LextJ} y={beamTop + 4 + barH + 2} width={LextJ - 4} height={barH - 2}
            fill="#2563eb" rx={2} />
          <text x={beamRight - LextJ + (LextJ - 4) / 2} y={beamTop + 4 + barH + 11}
            textAnchor="middle" fontSize={7} fill="white">
            +{prop.top_extra_j.n_bars}{prop.top_extra_j.bar_label}
          </text>
        </>
      )}

      {/* Barras inferiores continuas */}
      <rect x={beamLeft + 4} y={beamBottom - barH - 4} width={drawL - 8} height={barH}
        fill="#4a1212" rx={2} />
      <text x={mx + drawL / 2} y={beamBottom - 7} textAnchor="middle" fontSize={8} fill="white">
        {prop.bot_continuous.n_bars}{prop.bot_continuous.bar_label} corridas
      </text>

      {/* Estribos indicativos */}
      {[0.1, 0.25, 0.35, 0.5, 0.65, 0.75, 0.9].map((frac, i) => {
        const x = beamLeft + drawL * frac;
        return (
          <line key={i} x1={x} y1={beamTop - 2} x2={x} y2={beamBottom + 2}
            stroke="#555" strokeWidth={i < 2 || i > 4 ? 1.5 : 0.8} />
        );
      })}

      {/* Etiqueta de estribos */}
      <text x={beamLeft + 12} y={H - 2} fontSize={7} fill="#555">
        {prop.stirrups.zone_end.bar_label}@{prop.stirrups.zone_end.s_mm}
      </text>
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={7} fill="#555">
        {prop.stirrups.zone_mid.bar_label}@{prop.stirrups.zone_mid.s_mm}
      </text>
      <text x={W - mx} y={H - 2} textAnchor="end" fontSize={7} fill="#555">
        {prop.stirrups.zone_end.bar_label}@{prop.stirrups.zone_end.s_mm}
      </text>
    </svg>
  );
}

// ── Panel principal ───────────────────────────────────────────────────────────

export default function BeamDetailPanel({ projectId, data, onReinforcementSaved }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("reinforcement");

  const prop  = data.proposed_reinforcement;
  const userR = data.final_reinforcement?.reinforcement;

  const [nTop,    setNTop]    = useState(userR?.top_bars?.n_bars   ?? prop.top_continuous.n_bars);
  const [lblTop,  setLblTop]  = useState(userR?.top_bars?.bar_label ?? prop.top_continuous.bar_label);
  const [nBot,    setNBot]    = useState(userR?.bot_bars?.n_bars   ?? prop.bot_continuous.n_bars);
  const [lblBot,  setLblBot]  = useState(userR?.bot_bars?.bar_label ?? prop.bot_continuous.bar_label);
  const [tieEnd,  setTieEnd]  = useState(userR?.stirrups?.zone_end?.bar_label ?? prop.stirrups.zone_end.bar_label);
  const [sEnd,    setSEnd]    = useState(userR?.stirrups?.zone_end?.s_mm      ?? prop.stirrups.zone_end.s_mm);
  const [sMid,    setSMid]    = useState(userR?.stirrups?.zone_mid?.s_mm      ?? prop.stirrups.zone_mid.s_mm);
  const [notes,   setNotes]   = useState(data.final_reinforcement?.notes ?? "");

  const [verifyResult,  setVerifyResult]  = useState<any>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [saveLoading,   setSaveLoading]   = useState(false);
  const [saveOk,        setSaveOk]        = useState(false);
  const [apiError,      setApiError]      = useState<string | null>(null);

  const currentReinforcement: BeamReinforcementEdit = {
    top_bars: { n_bars: nTop, bar_label: lblTop },
    bot_bars: { n_bars: nBot, bar_label: lblBot },
    stirrups: {
      zone_end: { bar_label: tieEnd, n_legs: 2, s_mm: sEnd },
      zone_mid: { bar_label: tieEnd, n_legs: 2, s_mm: sMid },
    },
  };

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

  const displayChecks = verifyResult?.checks  ?? data.checks;
  const displayOk     = verifyResult?.overall_ok ?? data.overall_ok;
  const displayDCR    = verifyResult?.max_dcr    ?? data.max_dcr;

  const TABS: { id: Tab; label: string }[] = [
    { id: "info",         label: "Información" },
    { id: "demands",      label: "Demandas" },
    { id: "reinforcement", label: "Refuerzo" },
    { id: "checks",       label: "Verificaciones" },
  ];

  const seismicLabel = data.seismic_participation === "sismorresistente"
    ? "SISMORRESISTENTE" : "GRAVITACIONAL";
  const seismicColor = data.seismic_participation === "sismorresistente"
    ? "bg-blue-500/15 text-blue-700 border-blue-400/40"
    : "bg-amber-500/15 text-amber-700 border-amber-400/40";

  const statusInfo: Record<string, { label: string; color: string }> = {
    "OK":                   { label: "CUMPLE",          color: "bg-green-500 text-white" },
    "WARNING":              { label: "ADVERTENCIA",     color: "bg-amber-500 text-white" },
    "SECTION_INSUFFICIENT": { label: "SECCIÓN INSUF.",  color: "bg-red-600 text-white" },
    "DESIGN_ERROR":         { label: "ERROR DISEÑO",    color: "bg-red-800 text-white" },
    "GOVERNED_BY_ASMIN":    { label: "MÍNIMO",          color: "bg-sky-500 text-white" },
  };
  const ds = data.design_status ?? (displayOk ? "OK" : "SECTION_INSUFFICIENT");
  const dsInfo = statusInfo[ds] ?? { label: ds, color: "bg-gray-500 text-white" };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border)] ${
        displayOk ? "bg-green-500/5" : "bg-red-500/5"
      }`}>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-[var(--foreground)]">
              {data.frame_id}
            </h3>
            {data.user_modified && (
              <span className="text-xs font-normal text-blue-500">✎ modificado</span>
            )}
          </div>
          <p className="text-xs text-[var(--muted)]">
            {data.story} · {data.section} · {data.geometry.b_cm.toFixed(0)}×{data.geometry.h_cm.toFixed(0)} cm
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${seismicColor}`}>
              {seismicLabel}
            </span>
            {(data.combinations_used ?? []).length > 0 && (
              <span className="text-[10px] text-[var(--muted)] border border-[var(--border)] rounded px-1.5 py-0.5">
                {(data.combinations_used ?? []).join(" · ")}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${dsInfo.color}`}>
            {dsInfo.label}
          </span>
          <span className={`text-sm font-mono font-bold ${
            displayOk ? "text-green-600" : "text-red-500"
          }`}>
            DCR {displayDCR.toFixed(3)}
          </span>
        </div>
      </div>

      {/* Banner clasificación secundaria */}
      {data.seismic_participation === "gravitacional" && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-400/30 text-xs text-amber-700">
          ⚠ Elemento gravitacional — diseñado solo con combinaciones G1 y G2.
          No se aplican requisitos sísmicos NSR-10 C.18.6.
        </div>
      )}
      {ds === "SECTION_INSUFFICIENT" && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-400/30 text-xs text-red-700">
          ✕ Sección insuficiente — el momento de diseño supera la capacidad máxima
          con cuantía ρ_max. Se requiere aumentar la sección.
        </div>
      )}

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

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── TAB: INFORMACIÓN ──────────────────────────────────────────── */}
        {activeTab === "info" && (
          <table className="w-full text-xs">
            <tbody className="divide-y divide-[var(--border)]">
              {[
                ["Frame ID", data.frame_id],
                ["Piso", data.story],
                ["Sección", data.section],
                ["Participación sísmica", seismicLabel],
                ["Estado de diseño", dsInfo.label],
                ["Combinaciones", (data.combinations_used ?? []).join(", ") || "—"],
                ["Ancho b", `${data.geometry.b_cm.toFixed(0)} cm`],
                ["Alto h", `${data.geometry.h_cm.toFixed(0)} cm`],
                ["Longitud", `${data.geometry.L_m.toFixed(2)} m`],
                ["f'c", `${data.geometry.fc_MPa} MPa`],
                ["fy", `${data.geometry.fy_MPa} MPa`],
                ["Recubrimiento libre", `${(data.geometry.cover_m * 100).toFixed(0)} cm`],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td className="py-1.5 pr-3 text-[var(--muted)] w-44">{k}</td>
                  <td className="py-1.5 font-medium text-[var(--foreground)]">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── TAB: DEMANDAS ──────────────────────────────────────────────── */}
        {activeTab === "demands" && (
          <div className="space-y-4">
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Diagrama de momentos (kN·m)
            </h4>
            <MomentDiagram data={data} />

            {/* Demandas por zona con capacidad real */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Demandas y capacidad por zona
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-1 text-left text-[var(--muted)] pr-2">Zona</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">Mu (kN·m)</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">φMn (kN·m)</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">DCR</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">As col. (cm²)</th>
                    <th className="pb-1 text-right text-[var(--muted)]">d ef. (mm)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]/50">
                  {(["end_i", "mid", "end_j"] as const).map((zone) => {
                    const z  = data.demands.by_zone[zone];
                    const zr = data.reinforcement_by_zone[zone];
                    if (!z) return null;
                    const Mu = Math.max(z.Mu_neg_kNm, z.Mu_pos_kNm);
                    const phiMn = zr?.verify_top?.phi_Mn_kNm ?? z.phi_Mn_kNm;
                    const dcr   = zr?.verify_top?.dcr ?? z.dcr_flex;
                    const ok    = dcr <= 1.0;
                    const dEff  = zr?.verify_top?.d_eff_mm;
                    return (
                      <tr key={zone} className={ok ? "" : "bg-red-500/5"}>
                        <td className="py-1.5 pr-2 font-medium">
                          {zone === "end_i" ? "Extremo I" : zone === "mid" ? "Centro" : "Extremo J"}
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono">{Mu.toFixed(1)}</td>
                        <td className="py-1.5 pr-2 text-right font-mono text-green-700">{phiMn?.toFixed(1) ?? "—"}</td>
                        <td className={`py-1.5 pr-2 text-right font-mono font-semibold ${
                          ok ? "text-green-600" : "text-red-600"
                        }`}>{dcr?.toFixed(3) ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-right font-mono">
                          {zr ? `${zr.top.n_bars}×${zr.top.bar_label}` : "—"}
                        </td>
                        <td className="py-1.5 text-right font-mono text-[var(--muted)]">
                          {dEff?.toFixed(0) ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="font-semibold border-t border-[var(--border)]">
                    <td className="py-1.5 pr-2">Cortante máx.</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{data.demands.Vu_end_kN.toFixed(1)} kN</td>
                    <td colSpan={4}></td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Por combinación */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide pt-2">
              Por combinación
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-1 text-left text-[var(--muted)] pr-2">Combo</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">M⁻ (kN·m)</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">M⁺ (kN·m)</th>
                    <th className="pb-1 text-right text-[var(--muted)]">V (kN)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]/50">
                  {data.demands.by_combination.map((d) => (
                    <tr key={d.combo_id}>
                      <td className="py-1 pr-2">{d.combo_id}</td>
                      <td className="py-1 pr-2 text-right font-mono">{d.Mu_neg_kNm.toFixed(1)}</td>
                      <td className="py-1 pr-2 text-right font-mono">{d.Mu_pos_kNm.toFixed(1)}</td>
                      <td className="py-1 text-right font-mono">{d.Vu_kN.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── TAB: REFUERZO ─────────────────────────────────────────────── */}
        {activeTab === "reinforcement" && (
          <div className="space-y-4">
            {/* Vista longitudinal */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Armado longitudinal propuesto
            </h4>
            <div className="border border-[var(--border)] rounded p-2 bg-[var(--background)]">
              <LongitudinalView data={data} />
            </div>

            {/* Sección transversal */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Sección transversal
            </h4>
            <div className="flex justify-center border border-[var(--border)] rounded bg-[var(--background)] p-2">
              <SectionSVG
                b_m={data.geometry.b_m}
                h_m={data.geometry.h_m}
                cover_m={data.geometry.cover_m}
                diam_mm={
                  data.reinforcement_by_zone.mid?.top?.diam_mm ??
                  data.reinforcement_by_zone.end_i?.top?.diam_mm ?? 15.9
                }
                bar_positions={[
                  ...(data.reinforcement_by_zone.mid?.top?.bar_positions ?? []).map((p) => ({
                    x: p.x,
                    y: data.geometry.h_m * 500 - (data.geometry.cover_m * 1000),
                  })),
                  ...(data.reinforcement_by_zone.mid?.bot?.bar_positions ?? []).map((p) => ({
                    x: p.x,
                    y: -(data.geometry.h_m * 500 - (data.geometry.cover_m * 1000)),
                  })),
                ]}
                showDimensions={true}
                size={240}
              />
            </div>

            {/* Tabla de refuerzo por zona */}
            <h4 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">
              Acero por zona
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-1 text-left text-[var(--muted)] pr-2">Zona</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">As⁻ req.</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">As⁻ col.</th>
                    <th className="pb-1 text-right text-[var(--muted)] pr-2">As⁺ req.</th>
                    <th className="pb-1 text-right text-[var(--muted)]">As⁺ col.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]/50">
                  {(["end_i", "mid", "end_j"] as const).map((zone) => {
                    const zr = data.reinforcement_by_zone[zone];
                    if (!zr) return null;
                    return (
                      <tr key={zone}>
                        <td className="py-1.5 pr-2 font-medium">
                          {zone === "end_i" ? "Extremo I" : zone === "mid" ? "Centro" : "Extremo J"}
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono">{zr.As_top_req_cm2.toFixed(2)}</td>
                        <td className="py-1.5 pr-2 text-right font-mono text-green-600">
                          {zr.top.As_placed_cm2.toFixed(2)}<span className="text-[var(--muted)] ml-1">{zr.top.bar_label}</span>
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono">{zr.As_bot_req_cm2.toFixed(2)}</td>
                        <td className="py-1.5 text-right font-mono text-green-600">
                          {zr.bot.As_placed_cm2.toFixed(2)}<span className="text-[var(--muted)] ml-1">{zr.bot.bar_label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Editor refuerzo */}
            <div className="border border-[var(--border)] rounded p-3 space-y-3 bg-[var(--background)]">
              <h4 className="text-xs font-semibold text-[var(--foreground)]">Editar refuerzo longitudinal</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">N.º barras superiores</label>
                  <input type="number" min={2} max={10} value={nTop}
                    onChange={(e) => { setNTop(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Ø superiores</label>
                  <select value={lblTop} onChange={(e) => { setLblTop(e.target.value); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]">
                    {BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">N.º barras inferiores</label>
                  <input type="number" min={2} max={10} value={nBot}
                    onChange={(e) => { setNBot(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Ø inferiores</label>
                  <select value={lblBot} onChange={(e) => { setLblBot(e.target.value); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]">
                    {BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Editor estribos */}
            <div className="border border-[var(--border)] rounded p-3 space-y-3 bg-[var(--background)]">
              <h4 className="text-xs font-semibold text-[var(--foreground)]">Editar estribos</h4>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Estribo</label>
                  <select value={tieEnd} onChange={(e) => { setTieEnd(e.target.value); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]">
                    {TIE_BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">s extremos (mm)</label>
                  <input type="number" min={50} max={300} step={10} value={sEnd}
                    onChange={(e) => { setSEnd(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">s central (mm)</label>
                  <input type="number" min={50} max={400} step={10} value={sMid}
                    onChange={(e) => { setSMid(Number(e.target.value)); setVerifyResult(null); }}
                    className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)]"
                  />
                </div>
              </div>
              <div className="text-xs text-[var(--muted)]">
                Zona confinada: L = {(data.shear_design.zone_end.L_mm ?? 0).toFixed(0)} mm desde cada apoyo
              </div>
            </div>

            {/* Notas */}
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Notas del ingeniero</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full px-2 py-1.5 text-xs border border-[var(--border)] rounded bg-[var(--card)] text-[var(--foreground)] resize-none"
              />
            </div>

            {/* Error */}
            {apiError && (
              <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">{apiError}</div>
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
                  <ul className="mt-1 list-disc pl-4">
                    {verifyResult.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* Botones */}
            <div className="flex gap-2">
              <button onClick={handleVerify} disabled={verifyLoading}
                className="flex-1 py-2 text-xs font-semibold border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-50">
                {verifyLoading ? "Verificando..." : "↺ Verificar"}
              </button>
              <button onClick={handleSave} disabled={saveLoading}
                className={`flex-1 py-2 text-xs font-semibold rounded transition-colors disabled:opacity-50 ${
                  saveOk ? "bg-green-500 text-white" : "bg-[var(--accent)] text-white hover:opacity-90"
                }`}>
                {saveLoading ? "Guardando..." : saveOk ? "✓ Guardado" : "Guardar definitivo"}
              </button>
            </div>
          </div>
        )}

        {/* ── TAB: VERIFICACIONES ─────────────────────────────────────── */}
        {activeTab === "checks" && (
          <div className="space-y-2">
            {/* Resumen global */}
            <div className={`flex items-center justify-between text-sm font-semibold p-3 rounded border ${
              displayOk
                ? "text-green-700 bg-green-500/8 border-green-500/30"
                : "text-red-600 bg-red-500/8 border-red-500/30"
            }`}>
              <span>{displayOk ? "✓ Todas las verificaciones cumplen" : "✕ Hay verificaciones que no cumplen"}</span>
              <span className="text-xs font-mono">DCR máx = {displayDCR.toFixed(3)}</span>
            </div>

            {/* Checks detallados */}
            {Object.entries(displayChecks).map(([key, chk]: [string, any]) => {
              const labels: Record<string, string> = {
                flexure_end_i:  "Flexión · Extremo I",
                flexure_mid:    "Flexión · Centro",
                flexure_end_j:  "Flexión · Extremo J",
                shear_end:      "Cortante · Extremos",
                shear_mid:      "Cortante · Central",
                rho_min:        "Cuantía mínima",
                rho_max:        "Cuantía máxima",
                seismic_width:  "Ancho mínimo sismorresistente",
              };
              const zoneKey = key === "flexure_end_i" ? "end_i"
                            : key === "flexure_mid"   ? "mid"
                            : key === "flexure_end_j" ? "end_j"
                            : null;
              const zr = zoneKey ? data.reinforcement_by_zone[zoneKey] : null;
              const zd = zoneKey ? data.demands.by_zone[zoneKey] : null;
              const Mu = zd ? Math.max(zd.Mu_neg_kNm, zd.Mu_pos_kNm) : null;
              const phiMn = zr?.verify_top?.phi_Mn_kNm ?? null;
              return (
                <div key={key} className={`rounded border px-3 py-2 ${
                  chk.ok
                    ? "border-green-500/30 bg-green-500/5"
                    : "border-red-500/30 bg-red-500/10"
                }`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold text-[var(--foreground)]">
                        {labels[key] ?? key}
                      </span>
                      <span className="ml-2 text-[10px] text-[var(--muted)]">{chk.ref ?? "NSR-10"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {chk.dcr !== undefined && (
                        <span className={`text-xs font-mono ${
                          chk.dcr > 1.0 ? "text-red-500 font-bold" : chk.dcr > 0.85 ? "text-amber-600" : "text-green-600"
                        }`}>
                          DCR {chk.dcr.toFixed(3)}
                        </span>
                      )}
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        chk.ok ? "bg-green-500 text-white" : "bg-red-500 text-white"
                      }`}>
                        {chk.ok ? "✓" : "✕"}
                      </span>
                    </div>
                  </div>
                  {/* Detalle por zona de flexión */}
                  {Mu !== null && (
                    <div className="mt-1 text-[10px] text-[var(--muted)] font-mono flex gap-4">
                      <span>Mu = {Mu.toFixed(1)} kN·m</span>
                      {phiMn !== null && <span>φMn = {phiMn.toFixed(1)} kN·m</span>}
                    </div>
                  )}
                  {/* Detalle rho */}
                  {key === "rho_min" && chk.As_min_cm2 !== undefined && (
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      As_min = {chk.As_min_cm2} cm²
                    </div>
                  )}
                  {key === "rho_max" && chk.As_max_cm2 !== undefined && (
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      As_max = {chk.As_max_cm2} cm²
                    </div>
                  )}
                  {key === "seismic_width" && chk.b_cm !== undefined && (
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      b = {chk.b_cm} cm · mínimo = {chk.min_b_cm} cm
                    </div>
                  )}
                </div>
              );
            })}

            {data.warnings.length > 0 && (
              <div className="border border-amber-400/30 bg-amber-500/5 rounded p-2 space-y-1 mt-2">
                <div className="text-xs font-semibold text-amber-600">⚠ Advertencias</div>
                {data.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-700">{w}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
