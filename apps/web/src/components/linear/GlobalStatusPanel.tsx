"use client";

/**
 * GlobalStatusPanel — estado global del edificio bajo el pushover.
 *
 * Clarifica la diferencia entre:
 *   - Daño LOCAL (rótulas, elementos individuales)
 *   - Colapso GLOBAL (mecanismo de piso, caída de Vb, pérdida de estabilidad)
 *
 * Tres criterios de colapso global:
 *   1. Rótulas post-CP (ASCE 41 local) — contexto, no determina colapso del edificio.
 *   2. Mecanismo de piso                — fracción de columnas de un piso que
 *                                           cruzan CP. Umbral 80 % (configurable).
 *   3. Caída de Vb post-pico             — Vb_actual / Vb_pico < 0.80 ⇒ 20 % drop
 *                                           (ATC-40 / FEMA 356 convención usable).
 *
 * Verdict agregado: si (2) o (3) ⇒ colapso global.  Si solo (1) ⇒ edificio
 * dañado pero estable lateralmente.
 */
import { useMemo } from "react";

import type {
  NLFramePushoverDirResult, ElementLine, HingeDamageLevel,
} from "@/lib/structural-types";

const STORY_MECH_THRESHOLD = 0.80;    // 80 % cols de un piso en post-CP → mecanismo
const VB_DROP_THRESHOLD    = 0.80;    // Vb/Vb_pico < 0.80 → colapso por softening

interface Props {
  data:      NLFramePushoverDirResult;
  direction: string;
}

interface StoryStats {
  story:        string;
  total_cols:   number;
  post_cp_cols: number;
  ratio:        number;
  mechanism:    boolean;
}

export default function GlobalStatusPanel({ data, direction }: Props) {

  const stats = useMemo(() => _computeStats(data), [data]);

  const mechStories = stats.stories.filter(s => s.mechanism);
  const globalCollapse = mechStories.length > 0 || stats.vb_drop_detected;

  // ── Veredicto consolidado ────────────────────────────────────────────────
  let verdictLabel = "Edificio estable lateralmente";
  let verdictColor = "#16a34a";
  let verdictIcon  = "✓";
  let verdictDetail = "No se detectó colapso global por los 3 criterios evaluados.";

  if (globalCollapse) {
    verdictLabel = "Colapso global probable";
    verdictColor = "#dc2626";
    verdictIcon  = "⚠";
    const parts: string[] = [];
    if (mechStories.length > 0) {
      parts.push(`mecanismo de piso en ${mechStories.map(s => s.story).join(", ")}`);
    }
    if (stats.vb_drop_detected) {
      parts.push(`caída de Vb > 20 % (${((1 - stats.vb_min_ratio) * 100).toFixed(0)} %)`);
    }
    verdictDetail = `Disparadores: ${parts.join(" y ")}.`;
  } else if (stats.n_post_cp > 0) {
    verdictLabel = "Edificio dañado pero estable lateralmente";
    verdictColor = "#f97316";
    verdictIcon  = "⚠";
    verdictDetail = `${stats.n_post_cp} rótulas en estado Post-CP (daño local reparable). ` +
                    `Ningún criterio de colapso global disparado.`;
  }

  return (
    <div className="rounded-xl border-2 overflow-hidden"
         style={{ borderColor: verdictColor, background: `${verdictColor}08` }}>
      <div className="px-5 py-3 flex items-center gap-3"
           style={{ background: `${verdictColor}18`, borderBottom: `1px solid ${verdictColor}44` }}>
        <span className="text-2xl leading-none" style={{ color: verdictColor }}>
          {verdictIcon}
        </span>
        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest"
             style={{ color: verdictColor }}>
            Estado global · Dir {direction}
          </p>
          <p className="text-lg font-bold leading-tight" style={{ color: verdictColor }}>
            {verdictLabel}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] leading-snug mt-0.5">
            {verdictDetail}
          </p>
        </div>
      </div>

      {/* 3 criterios en grilla */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[var(--border)]">

        {/* Criterio 1: Rótulas locales post-CP */}
        <Criterion
          title="Rótulas post-CP (local)"
          value={`${stats.n_post_cp} / ${stats.n_hinges_total}`}
          subtitle={stats.n_hinges_total > 0
            ? `${((stats.n_post_cp / stats.n_hinges_total) * 100).toFixed(0)} % de rótulas evaluadas`
            : "—"}
          detail={
            <>
              Nivel ASCE 41 por rótula (θ_p ≥ 1.5·θ_CP).
              <b className="text-[var(--text)]"> NO determina colapso del edificio</b> —
              es daño local reparable (ver plan de reparación abajo).
            </>
          }
          color={stats.n_post_cp > 0 ? "#f97316" : "#64748b"}
          triggered={false}
        />

        {/* Criterio 2: Mecanismo de piso */}
        <Criterion
          title="Mecanismo de piso"
          value={mechStories.length > 0
            ? `SÍ · ${mechStories.length} piso${mechStories.length > 1 ? "s" : ""}`
            : "NO detectado"}
          subtitle={stats.critical_story
            ? `Piso crítico ${stats.critical_story.story}: ${stats.critical_story.post_cp_cols}/${stats.critical_story.total_cols} cols post-CP ` +
              `(${(stats.critical_story.ratio * 100).toFixed(0)} %)`
            : "—"}
          detail={
            <>
              Umbral: {(STORY_MECH_THRESHOLD * 100).toFixed(0)} % de columnas de un piso
              simultáneamente en post-CP ⇒ piso blando ⇒ colapso lateral global.
            </>
          }
          color={mechStories.length > 0 ? "#dc2626" : "#64748b"}
          triggered={mechStories.length > 0}
        />

        {/* Criterio 3: Caída de Vb */}
        <Criterion
          title="Caída de Vb post-pico"
          value={stats.vb_drop_pct !== null
            ? `${stats.vb_drop_pct.toFixed(0)} %`
            : "— no detectada"}
          subtitle={stats.vb_peak !== null
            ? `Vb pico ${stats.vb_peak.toFixed(0)} kN @ drift ${(stats.drift_at_peak ?? 0).toFixed(2)} %` +
              (stats.vb_last !== null
                ? ` · Vb último ${stats.vb_last.toFixed(0)} kN`
                : "")
            : "—"}
          detail={
            <>
              Umbral: Vb_actual / Vb_pico &lt; {VB_DROP_THRESHOLD.toFixed(2)} ⇒ caída &gt; {((1 - VB_DROP_THRESHOLD) * 100).toFixed(0)} %
              (ATC-40 / FEMA 356 — rango útil para evaluación).
            </>
          }
          color={stats.vb_drop_detected ? "#dc2626" : "#64748b"}
          triggered={stats.vb_drop_detected}
        />
      </div>
    </div>
  );
}

function Criterion({
  title, value, subtitle, detail, color, triggered,
}: {
  title: string; value: string; subtitle: string;
  detail: React.ReactNode;
  color: string; triggered: boolean;
}) {
  return (
    <div className="px-4 py-3 flex flex-col gap-1.5 bg-[var(--surface)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          {title}
        </p>
        {triggered && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase"
                style={{ background: `${color}22`, color }}>
            disparado
          </span>
        )}
      </div>
      <p className="text-xl font-bold font-mono leading-tight" style={{ color }}>
        {value}
      </p>
      <p className="text-[10px] text-[var(--text-muted)] font-mono">
        {subtitle}
      </p>
      <p className="text-[10px] text-[var(--text)] leading-snug mt-1 opacity-80">
        {detail}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface GlobalStats {
  n_post_cp:         number;
  n_hinges_total:    number;
  stories:           StoryStats[];
  critical_story:    StoryStats | null;
  vb_peak:           number | null;
  drift_at_peak:     number | null;
  vb_last:           number | null;
  vb_min_ratio:      number;   // min(Vb/Vb_pico) después del pico — para % drop
  vb_drop_pct:       number | null;  // 1 - vb_min_ratio, en %
  vb_drop_detected:  boolean;
}

function _computeStats(data: NLFramePushoverDirResult): GlobalStats {

  const hinges = data.damage?.hinges ?? [];
  const elementLines: ElementLine[] = data.element_lines ?? [];

  // ── Mecanismo de piso ─────────────────────────────────────────────────
  // Total de columnas por piso (desde element_lines)
  const totalColsByStory: Record<string, Set<string>> = {};
  for (const el of elementLines) {
    if (el.kind !== "column") continue;
    (totalColsByStory[el.story] = totalColsByStory[el.story] ?? new Set()).add(el.fid);
  }
  // Columnas en post-CP (level === "cp" || "collapse") por piso
  const postCPColsByStory: Record<string, Set<string>> = {};
  let n_post_cp = 0;
  const criticalLevels = new Set<HingeDamageLevel>(["cp", "collapse"]);
  for (const h of hinges) {
    if (criticalLevels.has(h.damage_level)) {
      n_post_cp += 1;
      if (h.kind === "column") {
        (postCPColsByStory[h.story] = postCPColsByStory[h.story] ?? new Set()).add(h.fid);
      }
    }
  }

  const stories: StoryStats[] = Object.entries(totalColsByStory)
    .map(([story, totalSet]) => {
      const postSet = postCPColsByStory[story] ?? new Set();
      const total = totalSet.size;
      const post  = postSet.size;
      const ratio = total > 0 ? post / total : 0;
      return {
        story, total_cols: total, post_cp_cols: post, ratio,
        mechanism: ratio >= STORY_MECH_THRESHOLD && total > 0,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);

  const critical_story = stories.length > 0 ? stories[0] : null;

  // ── Caída de Vb ────────────────────────────────────────────────────────
  const steps = data.steps ?? [];
  let vb_peak: number | null = null;
  let drift_at_peak: number | null = null;
  let peakIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const vb = Math.abs(steps[i].base_shear_kN);
    if (vb_peak === null || vb > vb_peak) {
      vb_peak = vb; drift_at_peak = steps[i].drift_pct; peakIdx = i;
    }
  }
  let vb_min_ratio = 1.0;
  let vb_last: number | null = null;
  if (peakIdx >= 0 && vb_peak !== null && vb_peak > 0) {
    for (let i = peakIdx + 1; i < steps.length; i++) {
      const r = Math.abs(steps[i].base_shear_kN) / vb_peak;
      if (r < vb_min_ratio) vb_min_ratio = r;
    }
    vb_last = steps.length > 0 ? Math.abs(steps[steps.length - 1].base_shear_kN) : null;
  }
  const vb_drop_detected = vb_min_ratio < VB_DROP_THRESHOLD;
  const vb_drop_pct = vb_peak !== null && peakIdx >= 0 && peakIdx < steps.length - 1
    ? (1 - vb_min_ratio) * 100
    : null;

  return {
    n_post_cp,
    n_hinges_total:   hinges.length,
    stories,
    critical_story,
    vb_peak, drift_at_peak, vb_last,
    vb_min_ratio, vb_drop_pct, vb_drop_detected,
  };
}

/** Export de los umbrales para que el PushoverChart pueda marcar el drop. */
export { VB_DROP_THRESHOLD, STORY_MECH_THRESHOLD };
