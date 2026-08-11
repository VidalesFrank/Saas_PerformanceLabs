"use client";

import { useEffect, useRef } from "react";
import type { SpectralResult, StoryDrift } from "@/lib/structural-types";

declare const Plotly: {
  newPlot: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => void;
  purge: (el: HTMLElement) => void;
};

// ── Helpers visuales ──────────────────────────────────────────────────────────

function StatPill({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={[
      "flex flex-col rounded-lg border px-3 py-2 min-w-[88px]",
      danger ? "border-[var(--color-danger)] bg-[var(--color-danger)]/5"
              : "border-border bg-surface-2",
    ].join(" ")}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      <span className={["mt-0.5 text-sm font-bold", danger ? "text-[var(--color-danger)]" : "text-text"].join(" ")}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted
                  border-b border-border pb-1 mb-3">
      {children}
    </p>
  );
}

// ── FHE Panel ─────────────────────────────────────────────────────────────────

function FHEPanel({ fhe }: { fhe: SpectralResult["fhe"] }) {
  const scaledAny = fhe.scaled_x || fhe.scaled_y;
  return (
    <div className={[
      "rounded-lg border p-4 mb-1",
      scaledAny
        ? "border-[var(--color-warning)] bg-[var(--color-warning)]/5"
        : "border-[var(--color-success)] bg-[var(--color-success)]/5",
    ].join(" ")}>
      <p className={[
        "text-sm font-semibold mb-3",
        scaledAny ? "text-[var(--color-warning)]" : "text-[var(--color-success)]",
      ].join(" ")}>
        {scaledAny
          ? "Cortante escalado — Vb_modal < Vb_min (NSR-10 A.4.2.2)"
          : "Cortante OK — Vb_modal ≥ Vb_min (NSR-10 A.4.2.2)"}
      </p>

      <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-xs">
        {/* Columna X */}
        <div>
          <p className="font-semibold text-text mb-2">Dirección X</p>
          <dl className="space-y-1">
            <div className="flex justify-between"><dt className="text-text-muted">W total</dt><dd className="font-medium text-text">{fhe.W_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Cs_min</dt><dd className="font-medium text-text">{fhe.Cs_min.toFixed(4)}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb modal</dt><dd className="font-medium text-text">{fhe.Vb_modal_x_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb mín.</dt><dd className="font-medium text-text">{fhe.Vb_min_x_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Factor escala</dt>
              <dd className={["font-bold", fhe.scaled_x ? "text-[var(--color-warning)]" : "text-text"].join(" ")}>
                {fhe.scale_x.toFixed(3)}{fhe.scaled_x ? " ⚠" : " ✓"}
              </dd>
            </div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb final</dt><dd className="font-bold text-text">{fhe.Vb_final_x_kN.toLocaleString("es-CO")} kN</dd></div>
          </dl>
        </div>

        {/* Columna Y */}
        <div>
          <p className="font-semibold text-text mb-2">Dirección Y</p>
          <dl className="space-y-1">
            <div className="flex justify-between"><dt className="text-text-muted">W total</dt><dd className="font-medium text-text">{fhe.W_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Cs_min</dt><dd className="font-medium text-text">{fhe.Cs_min.toFixed(4)}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb modal</dt><dd className="font-medium text-text">{fhe.Vb_modal_y_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb mín.</dt><dd className="font-medium text-text">{fhe.Vb_min_y_kN.toLocaleString("es-CO")} kN</dd></div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Factor escala</dt>
              <dd className={["font-bold", fhe.scaled_y ? "text-[var(--color-warning)]" : "text-text"].join(" ")}>
                {fhe.scale_y.toFixed(3)}{fhe.scaled_y ? " ⚠" : " ✓"}
              </dd>
            </div>
            <div className="flex justify-between"><dt className="text-text-muted">Vb final</dt><dd className="font-bold text-text">{fhe.Vb_final_y_kN.toLocaleString("es-CO")} kN</dd></div>
          </dl>
        </div>
      </div>
    </div>
  );
}

// ── Tabla de derivas ──────────────────────────────────────────────────────────

const DRIFT_LIMIT = 1.0;  // NSR-10 A.6.3: 1% para estructuras convencionales

function DriftTable({ drifts }: { drifts: StoryDrift[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-2">
            {["Piso", "h (m)", "Δx (%)", "Δy (%)", "δx (m)", "δy (m)", "NSR-10"].map((h) => (
              <th key={h} className="px-3 py-2 text-left font-semibold text-text-muted whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...drifts].reverse().map((d) => {
            const overX = d.drift_x_pct > DRIFT_LIMIT;
            const overY = d.drift_y_pct > DRIFT_LIMIT;
            const fail  = overX || overY;
            return (
              <tr key={d.story} className={["border-b border-border last:border-0", fail ? "bg-[var(--color-danger)]/5" : "hover:bg-surface-2"].join(" ")}>
                <td className="px-3 py-2 font-medium text-text">{d.story}</td>
                <td className="px-3 py-2 tabular-nums text-text-muted">{d.height_m.toFixed(2)}</td>
                <td className={["px-3 py-2 tabular-nums font-medium", overX ? "text-[var(--color-danger)]" : "text-text"].join(" ")}>
                  {d.drift_x_pct.toFixed(3)}
                </td>
                <td className={["px-3 py-2 tabular-nums font-medium", overY ? "text-[var(--color-danger)]" : "text-text"].join(" ")}>
                  {d.drift_y_pct.toFixed(3)}
                </td>
                <td className="px-3 py-2 tabular-nums text-text-muted">{d.disp_x_m.toFixed(4)}</td>
                <td className="px-3 py-2 tabular-nums text-text-muted">{d.disp_y_m.toFixed(4)}</td>
                <td className="px-3 py-2">
                  <span className={[
                    "inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-bold",
                    fail ? "bg-[var(--color-danger)]/20 text-[var(--color-danger)]"
                         : "bg-[var(--color-success)]/20 text-[var(--color-success)]",
                  ].join(" ")}>
                    {fail ? "FALLA" : "OK"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Gráfica de cortantes ──────────────────────────────────────────────────────

function ShearChart({
  stories, shears_x, shears_y,
}: {
  stories: string[];
  shears_x: Record<string, number>;
  shears_y: Record<string, number>;
}) {
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartRef.current || typeof Plotly === "undefined") return;
    const el = chartRef.current;

    const vx = stories.map((s) => shears_x[s] ?? 0);
    const vy = stories.map((s) => shears_y[s] ?? 0);

    Plotly.newPlot(
      el,
      [
        {
          type: "bar", orientation: "h",
          name: "Vx (kN)", x: vx, y: stories,
          marker: { color: "#54a3ff" },
          hovertemplate: "%{y}<br>Vx = %{x:.0f} kN<extra></extra>",
        },
        {
          type: "bar", orientation: "h",
          name: "Vy (kN)", x: vy, y: stories,
          marker: { color: "#34d399" },
          hovertemplate: "%{y}<br>Vy = %{x:.0f} kN<extra></extra>",
        },
      ],
      {
        barmode: "group",
        xaxis: { title: { text: "Cortante (kN)", font: { size: 11 } }, gridcolor: "#334155", color: "#94a3b8" },
        yaxis: { color: "#94a3b8", automargin: true },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor:  "rgba(0,0,0,0)",
        margin: { t: 16, r: 12, b: 40, l: 80 },
        font: { color: "#94a3b8", size: 11 },
        legend: { orientation: "h", y: -0.15 },
      },
      { responsive: true, displayModeBar: false }
    );
    return () => { if (typeof Plotly !== "undefined") Plotly.purge(el); };
  }, [stories, shears_x, shears_y]);

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden" style={{ height: Math.max(200, stories.length * 28 + 80) }}>
      <div ref={chartRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props {
  result: SpectralResult;
}

export function SpectralResultsPanel({ result }: Props) {
  const {
    fhe, story_drifts, story_shears_x, story_shears_y,
    combination_method, n_modes_used,
    mass_participation_x, mass_participation_y,
    spectral_params,
  } = result;

  const maxDriftX = Math.max(...story_drifts.map((d) => d.drift_x_pct), 0);
  const maxDriftY = Math.max(...story_drifts.map((d) => d.drift_y_pct), 0);
  const driftFail = maxDriftX > DRIFT_LIMIT || maxDriftY > DRIFT_LIMIT;

  // Pisos de base a techo
  const stories = story_drifts.map((d) => d.story);

  return (
    <div className="flex flex-col gap-5">

      {/* Resumen rápido */}
      <div className="flex flex-wrap gap-2">
        <StatPill label="Método"   value={combination_method} />
        <StatPill label="N° modos" value={String(n_modes_used)} />
        <StatPill label="∑Masa X"  value={`${mass_participation_x.toFixed(1)}%`} />
        <StatPill label="∑Masa Y"  value={`${mass_participation_y.toFixed(1)}%`} />
        <StatPill label="SDs"      value={`${spectral_params.SDs.toFixed(3)} g`} />
        <StatPill label="SD1"      value={`${spectral_params.SD1.toFixed(3)} g`} />
        <StatPill label="Δx_max"   value={`${maxDriftX.toFixed(3)}%`} danger={maxDriftX > DRIFT_LIMIT} />
        <StatPill label="Δy_max"   value={`${maxDriftY.toFixed(3)}%`} danger={maxDriftY > DRIFT_LIMIT} />
      </div>

      {/* Verificación FHE */}
      <div>
        <SectionTitle>Verificación FHE — NSR-10 A.4.2.2</SectionTitle>
        <FHEPanel fhe={fhe} />
      </div>

      {/* Cortantes de piso */}
      <div>
        <SectionTitle>Cortantes de piso</SectionTitle>
        <ShearChart stories={stories} shears_x={story_shears_x} shears_y={story_shears_y} />
      </div>

      {/* Derivas */}
      <div>
        <SectionTitle>
          Derivas de piso{driftFail ? " — ⚠ Excede límite NSR-10 (1%)" : " — OK (≤ 1%)"}
        </SectionTitle>
        <DriftTable drifts={story_drifts} />
        <p className="mt-1 text-[10px] text-text-muted">
          Derivas inelásticas Cd ≈ R · Δ_elástica (NSR-10 A.6.2). Límite: 1% para estructuras convencionales.
        </p>
      </div>
    </div>
  );
}
