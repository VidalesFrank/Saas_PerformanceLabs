"use client";

import { useState } from "react";
import type { AnalysisHealth } from "@/lib/structural-types";
import ElementDiagnosisPanel from "./ElementDiagnosisPanel";

/**
 * Banner con el diagnóstico de salud del solver (Ola 2 2026-11-04).
 *
 * - success + 0 fails  → verde minimalista (una línea)
 * - success + n_fails>0 → amarillo (tuvo bisecciones pero terminó)
 * - partial/aborted    → rojo (análisis incompleto, muestra el elemento peor)
 *
 * Se integra en los paneles NLTH y Pushover para que el ingeniero sepa si el
 * resultado es "limpio" o si hubo pelea del solver con algún elemento.
 *
 * Ola 7 — Si se pasa projectId y hay fid en el elemento patológico, muestra
 * botón "Diagnosticar" que abre el modal con recomendaciones de refuerzo.
 */
export function AnalysisHealthBanner({
  health,
  projectId,
}: {
  health?:    AnalysisHealth | null;
  projectId?: string;
}) {
  const [diagOpen, setDiagOpen] = useState(false);
  if (!health) return null;

  const ok      = health.status === "success" && !health.aborted;
  const hadFail = (health.n_failed_steps ?? 0) > 0 || (health.n_bisections_total ?? 0) > 0;
  const aborted = health.aborted;

  // Totalmente limpio → una línea verde
  if (ok && !hadFail) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-emerald-700 dark:text-emerald-400 font-medium">
          Análisis estable — 0 pasos fallidos, 0 bisecciones.
        </span>
      </div>
    );
  }

  const bannerCls = aborted
    ? "border-rose-500/40 bg-rose-500/5"
    : "border-amber-500/40 bg-amber-500/5";
  const dotCls = aborted ? "bg-rose-500" : "bg-amber-500";
  const titleCls = aborted
    ? "text-rose-800 dark:text-rose-300"
    : "text-amber-800 dark:text-amber-300";

  const pe = health.pathological_element;
  const isCollapse = health.abort_reason === "vb_near_zero";
  const bulldozerUsed = !!health.bulldozer_activated;
  const lossPct = health.vb_loss_pct ?? (
    health.vb_peak_kN && health.vb_at_abort_kN && health.vb_peak_kN > 0
      ? ((1 - health.vb_at_abort_kN / health.vb_peak_kN) * 100)
      : undefined
  );
  const title = isCollapse
    ? `Pushover detenido por colapso del edificio — Vb cayó ${lossPct?.toFixed(0) ?? "?"} % (de ${health.vb_peak_kN?.toFixed(1) ?? "?"} kN a ${health.vb_at_abort_kN?.toFixed(1) ?? "?"} kN)`
    : aborted
      ? `Análisis parcial — abortó por ${abortReasonLabel(health.abort_reason)}`
      : bulldozerUsed
        ? `Análisis completado con elementos patológicos aislados por modo tolerante (${health.bulldozer_steps_total ?? "?"} pasos)`
        : `Análisis completado con ${health.n_failed_steps} pasos fallidos / ${health.n_bisections_total} bisecciones`;

  return (
    <div className={`rounded-lg border ${bannerCls} px-3 py-3 space-y-2`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1 h-2 w-2 rounded-full ${dotCls} flex-shrink-0`} />
        <div className="flex-1">
          <div className={`text-sm font-semibold ${titleCls}`}>{title}</div>
          {aborted && health.abort_time_s != null && health.abort_time_target_s != null && (
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              Detenido en t = {health.abort_time_s.toFixed(3)}s de {health.abort_time_target_s.toFixed(1)}s
              {" "}
              ({((health.abort_time_s / health.abort_time_target_s) * 100).toFixed(1)}% completado)
            </div>
          )}
          {aborted && health.abort_step != null && (
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              Detenido en paso {health.abort_step}
              {health.abort_drift_pct != null && ` · deriva ${health.abort_drift_pct.toFixed(3)}%`}
            </div>
          )}
        </div>
      </div>

      {pe && (
        <div className="mt-2 rounded-md bg-[var(--panel-muted)] px-3 py-2 text-xs space-y-1">
          <div className="font-semibold text-[var(--text)]">Elemento con mayor demanda:</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {pe.fid && (
              <div><span className="text-[var(--text-muted)]">fid:</span>{" "}
                <span className="font-mono text-[var(--text)]">{pe.fid}</span></div>
            )}
            {pe.kind && (
              <div><span className="text-[var(--text-muted)]">tipo:</span>{" "}
                <span className="text-[var(--text)]">{pe.kind}</span></div>
            )}
            {pe.story && (
              <div><span className="text-[var(--text-muted)]">piso:</span>{" "}
                <span className="text-[var(--text)]">{pe.story}</span></div>
            )}
            <div><span className="text-[var(--text-muted)]">tag:</span>{" "}
              <span className="font-mono text-[var(--text)]">{pe.ele_tag}</span></div>
            {pe.theta_p_max != null && (
              <div><span className="text-[var(--text-muted)]">θ_p máx:</span>{" "}
                <span className="font-mono text-[var(--text)]">{(pe.theta_p_max * 1000).toFixed(2)} mrad</span></div>
            )}
            {pe.strain_axial != null && pe.strain_axial > 0 && (
              <div><span className="text-[var(--text-muted)]">ε axial:</span>{" "}
                <span className="font-mono text-[var(--text)]">{(pe.strain_axial * 1000).toFixed(2)}‰</span></div>
            )}
            {pe.force_max_kN != null && (
              <div><span className="text-[var(--text-muted)]">F máx:</span>{" "}
                <span className="font-mono text-[var(--text)]">{pe.force_max_kN.toFixed(1)} kN</span></div>
            )}
            {pe.b_m != null && pe.h_m != null && (pe.b_m > 0 || pe.h_m > 0) && (
              <div><span className="text-[var(--text-muted)]">sección:</span>{" "}
                <span className="font-mono text-[var(--text)]">{pe.b_m} × {pe.h_m} m</span></div>
            )}
          </div>
        </div>
      )}

      {aborted && (
        <div className="text-xs text-[var(--text-muted)] italic">
          {isCollapse
            ? "La curva se detuvo en el punto de colapso del edificio — Vb cayó al menos 75 % de su pico, umbral de pérdida irrecuperable de resistencia lateral (pandeo del refuerzo + aplastamiento del núcleo). Continuar carece de significado físico; la deriva reportada es el drift último estructural."
            : "Sugerencia: revisa el refuerzo de este elemento (más estribos / barras longitudinales mayores) o acepta el resultado parcial — ya refleja la demanda hasta el punto del colapso local."}
        </div>
      )}

      {/* Ola 7 — botón diagnóstico (solo si tenemos projectId y fid) */}
      {projectId && pe?.fid && (hadFail || aborted) && (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => setDiagOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5 shadow-sm"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a9 9 0 019 9h-3l3 4 3-4h-3a12 12 0 00-20 0" />
              <path d="M2 12a9 9 0 019-9" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Diagnosticar y recomendar refuerzo
          </button>
        </div>
      )}

      {diagOpen && projectId && pe?.fid && (
        <ElementDiagnosisPanel
          projectId={projectId}
          fid={pe.fid}
          onClose={() => setDiagOpen(false)}
        />
      )}
    </div>
  );
}

function abortReasonLabel(reason: AnalysisHealth["abort_reason"]): string {
  switch (reason) {
    case "step_fail":        return "no convergencia del solver";
    case "stall":            return "elemento numéricamente inestable (stall)";
    case "user_cancel":      return "cancelación del usuario";
    case "vb_near_zero":     return "cortante basal cayó a cero (colapso total)";
    case "slow_progress":    return "progreso muy lento del solver (edificio en colapso numérico)";
    case "bulldozer_failed": return "colapso generalizado (ni el modo tolerante pudo avanzar)";
    default:                 return "causa desconocida";
  }
}
