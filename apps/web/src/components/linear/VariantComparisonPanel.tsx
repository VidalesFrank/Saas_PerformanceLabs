"use client";

/**
 * VariantComparisonPanel — Comparativo baseline vs variante (Sprint 6.3).
 *
 * Muestra el impacto del rediseño en tres bloques:
 *   1. Curvas pushover X e Y superpuestas (baseline gris, variante color).
 *   2. Grid de métricas agregadas con delta % (verde mejora, rojo empeora).
 *   3. Tabla de pieres modificados: DI baseline → DI variante ordenada por
 *      mayor reducción.
 *
 * Se integra en NLPushoverPanel como sección expandible al presionar
 * "Ver resultado" en el VariantManager sobre una variante en estado "analyzed".
 */
import { useEffect, useMemo, useRef } from "react";
import type {
  NLPushoverResult,
  NLPushoverVariantResult,
  NLPushoverDirResult,
  DesignVariant,
  DamageLevel,
} from "@/lib/structural-types";

interface Props {
  baseline:  NLPushoverResult;
  variant:   NLPushoverVariantResult;
  variantMeta?: DesignVariant | null;
  onClose?:  () => void;
}

interface PierDamageRow {
  pier:         string;
  story:        string;
  drift_pct:    number;
  di_base:      number;
  di_effective: number;
  max_dcr:      number;
  ebe_required: boolean;
  damage_level: DamageLevel;
}

const DAMAGE_COLOR: Record<DamageLevel, string> = {
  none:     "#22c55e",
  minor:    "#a3e635",
  moderate: "#eab308",
  severe:   "#f97316",
  collapse: "#ef4444",
};

function extractPierDamage(res: NLPushoverResult): Record<"X" | "Y", PierDamageRow[]> {
  const out: Record<"X" | "Y", PierDamageRow[]> = { X: [], Y: [] };
  (["X", "Y"] as const).forEach((d) => {
    const dir = d === "X" ? res.pushover_X : res.pushover_Y;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[d] = ((dir as any)?.damage?.pier_damage ?? []) as PierDamageRow[];
  });
  return out;
}

function pickMaxDiPerPier(rows: PierDamageRow[]): Map<string, PierDamageRow> {
  const map = new Map<string, PierDamageRow>();
  for (const r of rows) {
    const k = `${r.pier}|${r.story}`;
    const prev = map.get(k);
    if (!prev || r.di_effective > prev.di_effective) map.set(k, r);
  }
  return map;
}

export default function VariantComparisonPanel({ baseline, variant, variantMeta, onClose }: Props) {
  const overrideKeys = useMemo(
    () => new Set(Object.keys(variantMeta?.overrides ?? {})),
    [variantMeta],
  );

  // ── Curvas pushover superpuestas ──────────────────────────────────────────
  const chartXRef = useRef<HTMLDivElement>(null);
  const chartYRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const Plotly = (window as unknown as {
      Plotly?: { newPlot: (...args: unknown[]) => void; purge: (el: Element) => void };
    }).Plotly;
    if (!Plotly) return;

    const build = (
      div: HTMLDivElement | null,
      bDir: NLPushoverDirResult | undefined,
      vDir: NLPushoverDirResult | undefined,
      color: string,
      dir: "X" | "Y",
    ) => {
      if (!div) return;
      const traces: unknown[] = [];
      if (bDir?.steps?.length) {
        traces.push({
          x: bDir.steps.map((s) => s.drift_pct),
          y: bDir.steps.map((s) => s.base_shear_kN),
          type: "scatter",
          mode: "lines",
          line: { color: "#94a3b8", width: 2, dash: "dash" as const },
          name: `Baseline (Vb máx ${bDir.summary?.max_base_shear_kN?.toFixed(1) ?? 0} kN)`,
          hovertemplate: "Baseline · Δ %{x:.3f}% · Vb %{y:.1f} kN<extra></extra>",
        });
      }
      if (vDir?.steps?.length) {
        traces.push({
          x: vDir.steps.map((s) => s.drift_pct),
          y: vDir.steps.map((s) => s.base_shear_kN),
          type: "scatter",
          mode: "lines",
          line: { color, width: 2.5 },
          name: `Variante (Vb máx ${vDir.summary?.max_base_shear_kN?.toFixed(1) ?? 0} kN)`,
          hovertemplate: "Variante · Δ %{x:.3f}% · Vb %{y:.1f} kN<extra></extra>",
        });
      }
      Plotly.newPlot(
        div,
        traces,
        {
          paper_bgcolor: "transparent",
          plot_bgcolor:  "transparent",
          font: { size: 11, color: "var(--text-muted)" },
          margin: { t: 10, r: 10, b: 50, l: 60 },
          xaxis: {
            title: { text: `Deriva de techo (%) — Dir ${dir}`, font: { size: 11 } },
            gridcolor: "var(--border)",
            zerolinecolor: "var(--border)",
          },
          yaxis: {
            title: { text: "Cortante basal (kN)", font: { size: 11 } },
            gridcolor: "var(--border)",
            zerolinecolor: "var(--border)",
          },
          legend: { orientation: "h" as const, y: -0.2 },
          showlegend: true,
        },
        { responsive: true, displayModeBar: false },
      );
    };

    build(chartXRef.current, baseline.pushover_X, variant.pushover_X, "#3b82f6", "X");
    build(chartYRef.current, baseline.pushover_Y, variant.pushover_Y, "#22c55e", "Y");

    return () => {
      if (chartXRef.current) Plotly.purge(chartXRef.current);
      if (chartYRef.current) Plotly.purge(chartYRef.current);
    };
  }, [baseline, variant]);

  // ── Métricas agregadas ────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const rows: {
      key:   string;
      label: string;
      bVal:  number;
      vVal:  number;
      unit:  string;
      /** Si true, una reducción se considera mejora (drift, DI, n_críticos). */
      lowerIsBetter: boolean;
      digits: number;
    }[] = [];

    (["X", "Y"] as const).forEach((d) => {
      const b = baseline.summary?.[d];
      const v = variant.summary?.[d];
      if (!b || !v) return;
      rows.push(
        { key: `drift_${d}`, label: `Deriva máx. ${d}`,      bVal: b.max_drift_pct ?? 0,     vVal: v.max_drift_pct ?? 0,     unit: "%",   lowerIsBetter: true,  digits: 3 },
        { key: `vb_${d}`,    label: `Vb máx. ${d}`,          bVal: b.max_base_shear_kN ?? 0, vVal: v.max_base_shear_kN ?? 0, unit: "kN",  lowerIsBetter: false, digits: 1 },
        { key: `di_${d}`,    label: `DI máx. ${d}`,          bVal: b.max_di ?? 0,             vVal: v.max_di ?? 0,             unit: "",    lowerIsBetter: true,  digits: 3 },
        { key: `nc_${d}`,    label: `Pieres críticos ${d}`,  bVal: b.n_critical_piers ?? 0,  vVal: v.n_critical_piers ?? 0,  unit: "",    lowerIsBetter: true,  digits: 0 },
      );
    });
    return rows;
  }, [baseline, variant]);

  // ── Pieres modificados: DI baseline vs variante ──────────────────────────
  const pierDeltas = useMemo(() => {
    const bDamage = extractPierDamage(baseline);
    const vDamage = extractPierDamage(variant);
    const bMax = pickMaxDiPerPier([...bDamage.X, ...bDamage.Y]);
    const vMax = pickMaxDiPerPier([...vDamage.X, ...vDamage.Y]);

    const rows: {
      key: string;
      pier: string;
      story: string;
      di_base: number;
      di_variant: number;
      delta: number;
      level_base: DamageLevel;
      level_variant: DamageLevel;
    }[] = [];

    overrideKeys.forEach((k) => {
      const [pier, story] = k.split("|");
      const b = bMax.get(k);
      const v = vMax.get(k);
      const di_base    = b?.di_effective ?? 0;
      const di_variant = v?.di_effective ?? 0;
      rows.push({
        key: k,
        pier: pier ?? "",
        story: story ?? "",
        di_base,
        di_variant,
        delta: di_variant - di_base,
        level_base:    b?.damage_level ?? "none",
        level_variant: v?.damage_level ?? "none",
      });
    });
    // Mayor reducción primero
    rows.sort((a, b) => a.delta - b.delta);
    return rows;
  }, [baseline, variant, overrideKeys]);

  return (
    <div className="rounded-xl border-2 border-[var(--accent)] bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface-2))] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Comparativo baseline vs variante
        </span>
        {variantMeta && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {variantMeta.name} · {overrideKeys.size} pier{overrideKeys.size === 1 ? "" : "es"} modificados
          </span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cerrar ✕
          </button>
        )}
      </div>

      {/* Curvas pushover superpuestas */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 p-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">
            Curva pushover — Dir X
          </p>
          <div ref={chartXRef} style={{ height: 260 }} />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">
            Curva pushover — Dir Y
          </p>
          <div ref={chartYRef} style={{ height: 260 }} />
        </div>
      </div>

      {/* Métricas agregadas */}
      <div className="px-4 pb-4">
        <p className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">
          Métricas agregadas
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {metrics.map((m) => {
            const delta = m.vVal - m.bVal;
            const deltaPct = m.bVal !== 0 ? (delta / m.bVal) * 100 : (m.vVal === 0 ? 0 : 100);
            const improved =
              m.lowerIsBetter ? delta < 0 : delta > 0;
            const worsened =
              m.lowerIsBetter ? delta > 0 : delta < 0;
            const color = improved ? "#16a34a" : worsened ? "#dc2626" : "var(--text-muted)";
            return (
              <div key={m.key} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                  {m.label}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] font-mono">
                  Baseline: {m.bVal.toFixed(m.digits)} {m.unit}
                </p>
                <p className="text-sm font-bold font-mono" style={{ color: "var(--text)" }}>
                  {m.vVal.toFixed(m.digits)} {m.unit}
                </p>
                <p className="text-[11px] font-semibold font-mono" style={{ color }}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(m.digits)}{" "}
                  ({delta >= 0 ? "+" : ""}{deltaPct.toFixed(1)}%)
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tabla de pieres modificados */}
      <div className="px-4 pb-4">
        <p className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">
          Pieres modificados — DI baseline vs variante
        </p>
        {pierDeltas.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] italic px-3 py-4">
            La variante no tiene pieres modificados.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-[var(--text-muted)]">Pier / Piso</th>
                  <th className="text-right px-3 py-2 font-semibold text-[var(--text-muted)]">DI baseline</th>
                  <th className="text-right px-3 py-2 font-semibold text-[var(--text-muted)]">DI variante</th>
                  <th className="text-right px-3 py-2 font-semibold text-[var(--text-muted)]">Δ DI</th>
                  <th className="text-right px-3 py-2 font-semibold text-[var(--text-muted)]">Δ %</th>
                  <th className="text-left px-3 py-2 font-semibold text-[var(--text-muted)]">Daño (b→v)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {pierDeltas.map((r) => {
                  const improved = r.delta < 0;
                  const worsened = r.delta > 0;
                  const color = improved ? "#16a34a" : worsened ? "#dc2626" : "var(--text-muted)";
                  const pct = r.di_base > 0 ? (r.delta / r.di_base) * 100 : 0;
                  return (
                    <tr key={r.key} className="hover:bg-[var(--surface-2)]">
                      <td className="px-3 py-1.5 font-medium text-[var(--text)]">
                        {r.pier} <span className="text-[var(--text-muted)]">/ {r.story}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text)]">
                        {r.di_base.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text)]">
                        {r.di_variant.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold" style={{ color }}>
                        {r.delta >= 0 ? "+" : ""}{r.delta.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold" style={{ color }}>
                        {r.di_base > 0 ? `${r.delta >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1">
                          <span
                            className="inline-block w-2 h-2 rounded-full"
                            style={{ background: DAMAGE_COLOR[r.level_base] }}
                            title={r.level_base}
                          />
                          <span className="text-[var(--text-muted)]">→</span>
                          <span
                            className="inline-block w-2 h-2 rounded-full"
                            style={{ background: DAMAGE_COLOR[r.level_variant] }}
                            title={r.level_variant}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
