"use client";

import { useEffect, useRef, useState } from "react";
import type { NLPushoverResult, NLPushoverDirResult } from "@/lib/structural-types";
import DeformedShape3D    from "./DeformedShape3D";
import CriticalPiersPanel from "./CriticalPiersPanel";
import PierResponseCurves from "./PierResponseCurves";

interface Props {
  result:    NLPushoverResult;
  projectId: string;
}

export default function NLPushoverPanel({ result, projectId }: Props) {
  const { pushover_X, pushover_Y, summary, fc_mpa, fy_mpa, target_drift_pct } = result;
  const [defDir, setDefDir] = useState<"X" | "Y">(
    pushover_X?.status === "success" || pushover_X?.status === "partial" ? "X" : "Y"
  );
  const [selectedPier, setSelectedPier] = useState<{ pier: string; story: string; direction: "X" | "Y" } | null>(null);

  function handleSelectPier(pier: string, story: string, dir?: "X" | "Y") {
    const d = dir ?? defDir;
    setSelectedPier({ pier, story, direction: d });
    setDefDir(d);
    // Scroll suave hacia la sección de respuesta local
    setTimeout(() => {
      document.getElementById("pier-response-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  }

  return (
    <div className="flex flex-col gap-5">

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "f'c",          value: `${fc_mpa} MPa`,        color: "var(--text)" },
          { label: "fy",           value: `${fy_mpa} MPa`,        color: "var(--text)" },
          { label: "Deriva obj.",  value: `${target_drift_pct}%`, color: "var(--text)" },
          {
            label: "Estado",
            value: Object.values(summary).every((s) => s.status === "success") ? "Completado" : "Parcial",
            color: Object.values(summary).every((s) => s.status === "success") ? "#22c55e" : "#f59e0b",
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">{label}</p>
            <p className="text-2xl font-bold font-mono" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Resumen por dirección ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(["X", "Y"] as const).map((dir) => {
          const s = summary[dir];
          if (!s) return null;
          const pct = s.total_steps > 0 ? (s.converged_steps / s.total_steps) * 100 : 0;
          const statusColor = s.status === "success" ? "#22c55e" : s.status === "partial" ? "#f59e0b" : "#ef4444";
          return (
            <div key={dir} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--text)]">Dirección {dir}</span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: `${statusColor}22`, color: statusColor }}>
                  {s.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div className="text-[var(--text-muted)]">Deriva máx.</div>
                <div className="text-right font-mono font-medium text-[var(--text)]">{(s.max_drift_pct ?? 0).toFixed(3)}%</div>
                <div className="text-[var(--text-muted)]">Vb máx.</div>
                <div className="text-right font-mono font-medium text-[var(--text)]">{(s.max_base_shear_kN ?? 0).toFixed(1)} kN</div>
                <div className="text-[var(--text-muted)]">Pasos conv.</div>
                <div className="text-right font-mono font-medium text-[var(--text)]">{s.converged_steps} / {s.total_steps}</div>
              </div>
              {/* Barra de progreso */}
              <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: statusColor }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Curvas pushover ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {pushover_X && <PushoverChart dir="X" data={pushover_X} color="#3b82f6" />}
        {pushover_Y && <PushoverChart dir="Y" data={pushover_Y} color="#22c55e" />}
      </div>

      {/* ── Deformada 3D animada ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[var(--text)] uppercase tracking-wider">
            Deformada 3D con Coloreo por Daño
          </h3>
          <div className="flex items-center gap-1">
            {(["X", "Y"] as const).map((d) => {
              const dirResult = d === "X" ? pushover_X : pushover_Y;
              const enabled = dirResult?.status === "success" || dirResult?.status === "partial";
              return (
                <button
                  key={d}
                  onClick={() => enabled && setDefDir(d)}
                  disabled={!enabled}
                  className={[
                    "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                    defDir === d
                      ? "bg-[var(--accent)] text-white"
                      : enabled
                      ? "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
                      : "bg-[var(--surface-2)] text-[var(--text-muted)] opacity-40 cursor-not-allowed",
                  ].join(" ")}
                >
                  Dir {d}
                </button>
              );
            })}
          </div>
        </div>
        <DeformedShape3D
          projectId={projectId}
          direction={defDir}
          height={520}
          onSelectPier={(pier, story) => handleSelectPier(pier, story, defDir)}
          selectedPier={selectedPier && selectedPier.direction === defDir ? { pier: selectedPier.pier, story: selectedPier.story } : null}
        />
        <p className="text-[10px] text-[var(--text-muted)] italic ml-1">
          Click en cualquier pier del 3D o en la tabla inferior para ver su curva M-φ y V-δ.
        </p>
      </div>

      {/* ── Respuesta local del pier seleccionado (M-φ y V-δ) ───────────────── */}
      {selectedPier && (
        <div id="pier-response-section" className="flex flex-col gap-2 scroll-mt-4">
          <h3 className="text-sm font-semibold text-[var(--text)] uppercase tracking-wider">
            Respuesta No Lineal del Pier
          </h3>
          <PierResponseCurves
            projectId={projectId}
            direction={selectedPier.direction}
            pier={selectedPier.pier}
            story={selectedPier.story}
            onClose={() => setSelectedPier(null)}
          />
        </div>
      )}

      {/* ── Ranking de pieres críticos ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--text)] uppercase tracking-wider">
          Elementos Críticos
        </h3>
        <CriticalPiersPanel
          result={result}
          onSelectPier={handleSelectPier}
          selectedPier={selectedPier ? { pier: selectedPier.pier, story: selectedPier.story } : null}
        />
      </div>

    </div>
  );
}

function PushoverChart({ dir, data, color }: { dir: string; data: NLPushoverDirResult; color: string }) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!divRef.current || !data.steps || data.steps.length === 0) return;

    const Plotly = (window as unknown as { Plotly: { newPlot: (...args: unknown[]) => void; purge: (el: Element) => void } }).Plotly;
    if (!Plotly) return;

    const drifts    = data.steps.map((s) => s.drift_pct);
    const shears    = data.steps.map((s) => s.base_shear_kN);

    Plotly.newPlot(
      divRef.current,
      [{
        x: drifts,
        y: shears,
        type: "scatter",
        mode: "lines",
        line: { color, width: 2 },
        name: `Vb (kN)`,
        hovertemplate: "Deriva: %{x:.3f}%<br>Vb: %{y:.1f} kN<extra></extra>",
      }],
      {
        paper_bgcolor: "transparent",
        plot_bgcolor:  "transparent",
        font: { size: 11, color: "var(--text-muted)" },
        margin: { t: 10, r: 10, b: 50, l: 60 },
        xaxis: {
          title: { text: "Deriva de techo (%)", font: { size: 11 } },
          gridcolor: "var(--border)",
          zerolinecolor: "var(--border)",
        },
        yaxis: {
          title: { text: "Cortante basal (kN)", font: { size: 11 } },
          gridcolor: "var(--border)",
          zerolinecolor: "var(--border)",
        },
        showlegend: false,
      },
      { responsive: true, displayModeBar: false },
    );

    return () => {
      if (divRef.current) Plotly.purge(divRef.current);
    };
  }, [data, color]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs font-semibold text-[var(--text-muted)] mb-3 uppercase tracking-wider">
        Curva Pushover — Dirección {dir}
      </p>
      {data.steps && data.steps.length > 0 ? (
        <div ref={divRef} style={{ height: 280 }} />
      ) : (
        <div className="flex items-center justify-center h-[280px] text-xs text-[var(--text-muted)]">
          Sin pasos convergidos en esta dirección
        </div>
      )}
      <p className="text-[10px] text-[var(--text-muted)] mt-2 text-center">
        {data.converged_steps} pasos · deriva máx {(data.summary?.max_drift_pct ?? 0).toFixed(3)}% · Vb máx {(data.summary?.max_base_shear_kN ?? 0).toFixed(1)} kN
      </p>
    </div>
  );
}
