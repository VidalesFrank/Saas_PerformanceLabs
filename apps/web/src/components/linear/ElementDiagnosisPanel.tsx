"use client";

/**
 * Panel de diagnóstico post-NLTH de un elemento + recomendaciones de refuerzo (Ola 7).
 *
 * Se abre como modal desde el AnalysisHealthBanner cuando existe un
 * `pathological_element.fid`. Llama a:
 *   GET  /nlth/element-diagnosis/{fid}
 *   POST /nlth/apply-reinforcement-fix
 *
 * Muestra:
 *   - Verdict (ok / info / warning / danger)
 *   - Tabla de capacidades y demanda (D/C para θ y V)
 *   - Lista de recomendaciones ordenadas por costo con botón "Aplicar al modelo"
 *   - Hint para relanzar el NLTH tras aplicar un fix
 */

import { useCallback, useEffect, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { ElementDiagnosis, ReinforcementOption } from "@/lib/structural-types";

interface Props {
  projectId: string;
  fid:       string;
  onClose:   () => void;
}

export default function ElementDiagnosisPanel({ projectId, fid, onClose }: Props) {
  const [diag, setDiag] = useState<ElementDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const fetchDiag = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await structuralAnalysisApi.getElementDiagnosis(projectId, fid);
      setDiag(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, fid]);

  useEffect(() => { fetchDiag(); }, [fetchDiag]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const applyFix = async (rec: ReinforcementOption) => {
    if (!diag) return;
    setApplying(rec.action_id);
    try {
      await structuralAnalysisApi.applyReinforcementFix(projectId, {
        fid:       diag.fid,
        action_id: rec.action_id,
        changes:   rec.changes,
        notes:     `Ola 7 — ${rec.description}`,
      });
      setApplied(rec.action_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm px-4 py-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="pl-glass w-full max-w-5xl rounded-2xl shadow-2xl border border-white/40 dark:border-white/10 p-6 space-y-5">
        {/* ── Header ───────────────────────────────────────────── */}
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <span className="uppercase tracking-wider font-semibold">Diagnóstico post-NLTH</span>
              <span className="opacity-40">·</span>
              <span>Ola 7</span>
            </div>
            <h2 className="mt-1 text-xl font-semibold text-[var(--text)]">
              Elemento <span className="font-mono text-indigo-600 dark:text-indigo-400">{fid}</span>
              {diag && (
                <>
                  <span className="mx-2 text-sm text-[var(--text-muted)] font-normal">·</span>
                  <span className="text-sm text-[var(--text-muted)] font-normal">
                    {diag.kind === "column" ? "Columna" : "Viga"} {diag.b_m}×{diag.h_m} m · {diag.story}
                  </span>
                </>
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--panel-muted)]"
            aria-label="Cerrar"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {/* ── Loading / error ──────────────────────────────────── */}
        {loading && (
          <div className="rounded-lg bg-[var(--panel-muted)] p-6 text-center text-sm text-[var(--text-muted)]">
            Calculando diagnóstico (M-φ + modo de falla + Haselton + recomendaciones)…
          </div>
        )}
        {error && !loading && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* ── Verdict ──────────────────────────────────────────── */}
        {diag && !loading && (
          <>
            <VerdictBanner verdict={diag.verdict} level={diag.verdict_class} />

            {/* ── Capacidad actual + Demanda ─────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CapacityCard diag={diag} />
              <DemandCard diag={diag} />
            </div>

            {/* ── Banderas de detallado ──────────────────────────── */}
            {diag.flags.length > 0 && (
              <FlagsPanel flags={diag.flags} />
            )}

            {/* ── Recomendaciones ────────────────────────────────── */}
            {diag.recommendations.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-base font-semibold text-[var(--text)]">
                    Recomendaciones ordenadas por costo
                  </h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {diag.recommendations.length} opciones disponibles
                  </span>
                </div>
                <div className="space-y-2.5">
                  {diag.recommendations.map((rec) => (
                    <RecommendationCard
                      key={rec.action_id}
                      rec={rec}
                      applying={applying === rec.action_id}
                      applied={applied === rec.action_id}
                      onApply={() => applyFix(rec)}
                    />
                  ))}
                </div>
              </section>
            ) : (
              <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">
                No se identificaron intervenciones necesarias para este elemento
                con la demanda actual.
              </div>
            )}

            {applied && (
              <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-4 text-sm text-indigo-700 dark:text-indigo-300 space-y-1">
                <div className="font-semibold">Fix aplicado — <span className="font-mono">{applied}</span></div>
                <div>
                  El refuerzo override se guardó en <span className="font-mono">reinforcement.json</span>.
                  Relanza el NLTH para verificar la mejora numérica.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-componentes ─────────────────────────────────────────────────────────

function VerdictBanner({ verdict, level }: { verdict: string; level: ElementDiagnosis["verdict_class"] }) {
  const cls = {
    ok:      "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
    info:    "border-slate-500/30 bg-slate-500/5 text-slate-700 dark:text-slate-300",
    warning: "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300",
    danger:  "border-rose-500/40 bg-rose-500/5 text-rose-800 dark:text-rose-300",
  }[level];
  return (
    <div className={`rounded-lg border ${cls} px-4 py-3 text-sm font-medium leading-relaxed`}>
      {verdict}
    </div>
  );
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span className="font-mono text-sm text-[var(--text)]">
        {value}
        {hint && <span className="ml-1 text-[11px] text-[var(--text-muted)]">{hint}</span>}
      </span>
    </div>
  );
}

function CapacityCard({ diag }: { diag: ElementDiagnosis }) {
  return (
    <div className="pl-glass-soft rounded-xl p-4 space-y-2">
      <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
        Capacidad actual
      </h4>
      <StatRow label="ρ longitudinal"  value={(diag.rho_long * 100).toFixed(2) + " %"} />
      <StatRow label="ρ transversal"   value={(diag.rho_sh * 100).toFixed(3) + " %"} />
      <StatRow label="Estribos"        value={`${diag.tie_bar_label} @ ${diag.s_confined_mm.toFixed(0)} mm · ${diag.n_legs_h} ramas`} />
      <div className="my-2 border-t border-[var(--panel-muted)]" />
      <StatRow label="θ_IO (Ocupación inmediata)" value={(diag.theta_IO * 1000).toFixed(2) + " mrad"} />
      <StatRow label="θ_LS (Seguridad de la vida)" value={(diag.theta_LS * 1000).toFixed(2) + " mrad"} />
      <StatRow label="θ_CP (Prevención de colapso)" value={(diag.theta_CP * 1000).toFixed(2) + " mrad"} />
      <StatRow label="Vp = 2·Mp/Ln"    value={diag.Vp_kN.toFixed(1) + " kN"} />
      <StatRow label="Vn (gobernante)" value={diag.Vn_kN.toFixed(1) + " kN"} />
      <StatRow label="Vp / Vn"         value={diag.Vp_over_Vn.toFixed(2)}
               hint={diag.Vp_over_Vn > 1 ? "⇒ cortante" : diag.Vp_over_Vn > 0.6 ? "⇒ flexo-cortante" : "⇒ flexión"} />
      <div className="my-2 border-t border-[var(--panel-muted)]" />
      <StatRow label="Modo de falla"    value={diag.failure_mode} />
      <StatRow label="Condición ASCE 41" value={diag.asce_condition.toUpperCase()} />
    </div>
  );
}

function DemandCard({ diag }: { diag: ElementDiagnosis }) {
  const dcrColor = diag.theta_dcr > 1.0 ? "text-rose-600 dark:text-rose-400"
                : diag.theta_dcr > 0.8 ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="pl-glass-soft rounded-xl p-4 space-y-2">
      <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
        Demanda del NLTH
      </h4>
      <StatRow label="θ_p máx (observada)" value={(diag.theta_demand * 1000).toFixed(2) + " mrad"} />
      {diag.V_demand_kN != null && (
        <StatRow label="V demanda" value={diag.V_demand_kN.toFixed(1) + " kN"} />
      )}
      <div className="my-3 border-t border-[var(--panel-muted)]" />
      <div className="text-center py-2">
        <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider mb-1">
          Demanda / Capacidad (θ_demand / θ_CP)
        </div>
        <div className={`font-mono text-3xl font-semibold ${dcrColor}`}>
          {diag.theta_dcr.toFixed(2)}
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-1">
          {diag.theta_dcr > 1.0
            ? `${((diag.theta_dcr - 1) * 100).toFixed(0)} % sobre capacidad de prevención de colapso`
            : `${((1 - diag.theta_dcr) * 100).toFixed(0)} % de margen disponible`}
        </div>
      </div>
    </div>
  );
}

function FlagsPanel({ flags }: { flags: string[] }) {
  const FLAG_LABELS: Record<string, string> = {
    HOOK_90:         "Gancho sísmico a 90° (no cumple NSR-10 C.21.5.6)",
    SPLICE_IN_HINGE: "Empalme por traslape en zona de rótula (ACI 318 §18.7.5)",
    S_OVER_DB_GT_6:  "s/db > 6 → riesgo de pandeo del refuerzo longitudinal",
    RHO_SH_LT_DMO:   "ρ_sh < mínimo NSR-10 C.21 DMO",
    RHO_SH_LT_DES:   "ρ_sh < mínimo ACI 318 §18.7.5 DES",
    LOW_CONFINEMENT: "ρ_s volumétrica < 0.004 (confinamiento insuficiente)",
    HIGH_AXIAL:      "ν > 0.5 (columna muy cargada axialmente)",
  };
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-1">
      <h4 className="text-xs uppercase tracking-wider font-semibold text-amber-800 dark:text-amber-300">
        Banderas de detallado deficiente
      </h4>
      <ul className="mt-1.5 space-y-1 text-sm text-amber-900 dark:text-amber-200">
        {flags.map((f) => (
          <li key={f} className="flex gap-2 items-baseline">
            <span className="font-mono text-xs opacity-70">●</span>
            <span>{FLAG_LABELS[f] ?? f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecommendationCard({
  rec, applying, applied, onApply,
}: {
  rec:      ReinforcementOption;
  applying: boolean;
  applied:  boolean;
  onApply:  () => void;
}) {
  const tierStyle = rec.cost_tier === 1
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
    : rec.cost_tier === 2
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
      : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30";
  const tierLabel = rec.cost_tier === 1 ? "BAJO" : rec.cost_tier === 2 ? "MEDIO" : "ALTO";
  const gainColor = rec.theta_cap_gain_pct > 0 ? "text-emerald-600 dark:text-emerald-400"
                  : rec.theta_cap_gain_pct < 0 ? "text-rose-600 dark:text-rose-400"
                  : "text-[var(--text-muted)]";
  const dcrOk = rec.new_theta_dcr <= 1.0;

  return (
    <div className="pl-glass-soft rounded-xl p-4 border border-[var(--panel-muted)]/50 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${tierStyle}`}>
              COSTO {tierLabel}
            </span>
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {rec.action_id}
            </span>
            <span className="text-xs font-semibold text-[var(--text)]">
              ~ USD {rec.cost_estimate_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            {rec.meets_target && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500 text-white">
                CUMPLE OBJETIVO
              </span>
            )}
          </div>
          <div className="text-sm font-medium text-[var(--text)]">{rec.description}</div>
        </div>
        <button
          type="button"
          onClick={onApply}
          disabled={applying || applied}
          className={`
            shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold
            ${applied
              ? "bg-emerald-500 text-white cursor-default"
              : applying
                ? "bg-[var(--panel-muted)] text-[var(--text-muted)] cursor-wait"
                : "bg-indigo-600 text-white hover:bg-indigo-700"}
          `}
        >
          {applied ? "✓ Aplicado" : applying ? "Aplicando…" : "Aplicar al modelo"}
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">{rec.rationale}</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-[var(--panel-muted)]/40">
        <div>
          <div className="text-[10px] uppercase text-[var(--text-muted)]">θ_CP nuevo</div>
          <div className="font-mono text-sm text-[var(--text)]">
            {(rec.theta_cap_new * 1000).toFixed(2)} mrad
          </div>
          <div className={`text-xs ${gainColor}`}>
            {rec.theta_cap_gain_pct >= 0 ? "+" : ""}{rec.theta_cap_gain_pct.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--text-muted)]">Vn nuevo</div>
          <div className="font-mono text-sm text-[var(--text)]">
            {rec.Vn_new_kN.toFixed(0)} kN
          </div>
          <div className={`text-xs ${rec.Vn_gain_pct > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--text-muted)]"}`}>
            {rec.Vn_gain_pct > 0 ? "+" : ""}{rec.Vn_gain_pct.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--text-muted)]">Vp/Vn nuevo</div>
          <div className="font-mono text-sm text-[var(--text)]">
            {rec.Vp_over_Vn_new.toFixed(2)}
          </div>
          <div className="text-xs text-[var(--text-muted)]">{rec.failure_mode_new}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--text-muted)]">D/C nuevo</div>
          <div className={`font-mono text-sm ${dcrOk ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {rec.new_theta_dcr.toFixed(2)}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {dcrOk ? "cumple θ_CP" : "sigue sobre θ_CP"}
          </div>
        </div>
      </div>

      {rec.notes && rec.notes.length > 0 && (
        <div className="text-[11px] italic text-[var(--text-muted)] pt-1">
          {rec.notes.join(" · ")}
        </div>
      )}
    </div>
  );
}
