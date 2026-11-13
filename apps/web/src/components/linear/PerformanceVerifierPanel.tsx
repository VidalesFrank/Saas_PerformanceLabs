"use client";

/**
 * Panel Performance-Based Verifier (Ola 8).
 *
 * Ubicación: paso de diseño del Módulo 1. Permite verificar que todos los
 * elementos cumplan θ_target según nivel de desempeño ASCE 41-17 y, si no
 * cumplen, auto-ajustar el refuerzo (reducir s, agregar legs, etc.) antes
 * de que se lance NLTH/Pushover.
 *
 * Diferenciador vs Perform-3D / SAP-NL: evita iteraciones manuales usuario ↔
 * análisis, garantizando que el modelo sea "NLTH-ready" por construcción.
 */

import { useCallback, useEffect, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type {
  PerformanceLevel, PerformanceVerificationResult, ElementVerification,
} from "@/lib/structural-types";

interface Props {
  projectId: string;
}

export default function PerformanceVerifierPanel({ projectId }: Props) {
  const [level, setLevel] = useState<PerformanceLevel>("LS");
  const [thetaCol, setThetaCol] = useState<number | "">("");    // empty = default
  const [thetaBeam, setThetaBeam] = useState<number | "">("");
  const [maxIter, setMaxIter] = useState<number>(8);
  const [result, setResult] = useState<PerformanceVerificationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unmet" | "adjusted">("all");

  const loadLast = useCallback(async () => {
    try {
      const r = await structuralAnalysisApi.getPerformanceVerification(projectId);
      setResult(r);
    } catch {
      // no previo → ignorar
    }
  }, [projectId]);

  useEffect(() => { loadLast(); }, [loadLast]);

  const run = async (saveFixes = false) => {
    saveFixes ? setSaving(true) : setRunning(true);
    setError(null);
    try {
      const r = await structuralAnalysisApi.verifyPerformanceCapacity(projectId, {
        performance_level:    level,
        theta_target_column:  thetaCol === "" ? undefined : thetaCol,
        theta_target_beam:    thetaBeam === "" ? undefined : thetaBeam,
        max_iterations:       maxIter,
        save_fixes:           saveFixes,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setSaving(false);
    }
  };

  const filtered = result?.elements.filter((e) => {
    if (filter === "unmet")     return !e.meets_target_final;
    if (filter === "adjusted")  return !e.meets_target_initial && e.meets_target_final;
    return true;
  }) ?? [];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text)]">
          Verificación por desempeño (ASCE 41-17)
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          Garantiza que el modelo cumpla θ_target antes de lanzar el NLTH.
          Si un elemento no cumple, el motor propone ajustes incrementales
          (s↓, legs↑, estribo↑, barra long↑) y los puede persistir en el
          refuerzo del proyecto.
        </p>
      </header>

      {/* ── Parámetros ─────────────────────────────────────────────────────── */}
      <div className="pl-glass-soft rounded-xl p-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div>
          <label className="text-xs text-[var(--text-muted)] mb-1 block">
            Nivel de desempeño
          </label>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as PerformanceLevel)}
            className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]"
          >
            <option value="IO">IO — Immediate Occupancy</option>
            <option value="LS">LS — Life Safety</option>
            <option value="CP">CP — Collapse Prevention</option>
          </select>
        </div>
        <NumberField
          label="θ_target columna (mrad)"
          placeholder={level === "IO" ? "5" : level === "LS" ? "15" : "25"}
          value={thetaCol === "" ? "" : (thetaCol * 1000).toFixed(1)}
          onChange={(v) => setThetaCol(v === "" ? "" : Number(v) / 1000)}
        />
        <NumberField
          label="θ_target viga (mrad)"
          placeholder={level === "IO" ? "10" : level === "LS" ? "20" : "35"}
          value={thetaBeam === "" ? "" : (thetaBeam * 1000).toFixed(1)}
          onChange={(v) => setThetaBeam(v === "" ? "" : Number(v) / 1000)}
        />
        <NumberField
          label="Iteraciones máx"
          placeholder="8"
          value={String(maxIter)}
          onChange={(v) => setMaxIter(Math.max(1, Math.min(20, Number(v) || 6)))}
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={running || saving}
          className="rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2"
        >
          {running ? "Verificando…" : "Verificar (sin persistir)"}
        </button>
        <button
          type="button"
          onClick={() => run(true)}
          disabled={running || saving || !result}
          className="rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2"
        >
          {saving ? "Guardando…" : "Verificar y aplicar ajustes"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── Resultados ─────────────────────────────────────────────────────── */}
      {result && (
        <>
          <SummaryCard result={result} />

          {Object.keys(result.summary_adjustments).length > 0 && (
            <div className="pl-glass-soft rounded-xl p-4">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-2">
                Ajustes realizados (agrupados)
              </h4>
              <div className="flex gap-2 flex-wrap">
                {Object.entries(result.summary_adjustments).map(([k, n]) => (
                  <span key={k} className="rounded-md bg-[var(--panel-muted)] px-2 py-1 text-xs font-mono">
                    {k}: <span className="font-bold">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {result.saved_fixes && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              <strong>Refuerzo actualizado</strong> — {result.saved_fixes_count} fid ajustados en{" "}
              <span className="font-mono">reinforcement.json</span>. El próximo pushover/NLTH
              leerá los nuevos valores automáticamente.
            </div>
          )}

          {/* Tabla de elementos */}
          <section className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-semibold text-[var(--text)]">
                Detalle por elemento ({filtered.length} / {result.elements.length})
              </h3>
              <div className="flex gap-1">
                {(["all", "adjusted", "unmet"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-2.5 py-1 rounded text-xs font-medium ${
                      filter === f
                        ? "bg-indigo-600 text-white"
                        : "bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    {f === "all" ? "Todos" : f === "adjusted" ? "Ajustados" : "Sin cumplir"}
                  </button>
                ))}
              </div>
            </div>
            <ElementTable rows={filtered} />
          </section>

          {result.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div className="font-semibold">Advertencias</div>
              {result.warnings.slice(0, 10).map((w, i) => (
                <div key={i} className="font-mono">{w}</div>
              ))}
              {result.warnings.length > 10 && (
                <div className="italic">… y {result.warnings.length - 10} más.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NumberField({
  label, placeholder, value, onChange,
}: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs text-[var(--text-muted)] mb-1 block">{label}</label>
      <input
        type="number"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)] font-mono"
      />
    </div>
  );
}

function SummaryCard({ result }: { result: PerformanceVerificationResult }) {
  const okPct = result.n_elements > 0
    ? ((result.n_initial_pass + result.n_adjusted) / result.n_elements) * 100
    : 0;
  return (
    <div className="pl-glass rounded-2xl p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
            Nivel {result.performance_level} · {result.n_elements} elementos
          </div>
          <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
            θ_target col = {(result.theta_targets.column * 1000).toFixed(1)} mrad ·
            viga = {(result.theta_targets.beam * 1000).toFixed(1)} mrad · método = {result.method}
          </div>
        </div>
        <div className={`text-3xl font-mono font-semibold ${
          okPct === 100 ? "text-emerald-600 dark:text-emerald-400"
          : okPct >= 90 ? "text-amber-600 dark:text-amber-400"
          : "text-rose-600 dark:text-rose-400"
        }`}>
          {okPct.toFixed(0)}%
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[var(--panel-muted)]/40">
        <Stat label="Cumplen inicial" value={result.n_initial_pass} color="emerald" />
        <Stat label="Ajustados"       value={result.n_adjusted}    color="amber" />
        <Stat label="No cumplen"      value={result.n_unmet}       color={result.n_unmet > 0 ? "rose" : "muted"} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: {
  label: string; value: number; color: "emerald" | "amber" | "rose" | "muted";
}) {
  const cls = {
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber:   "text-amber-600 dark:text-amber-400",
    rose:    "text-rose-600 dark:text-rose-400",
    muted:   "text-[var(--text-muted)]",
  }[color];
  return (
    <div>
      <div className="text-[11px] uppercase text-[var(--text-muted)]">{label}</div>
      <div className={`text-2xl font-mono font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function ElementTable({ rows }: { rows: ElementVerification[] }) {
  if (rows.length === 0) {
    return (
      <div className="pl-glass-soft rounded-xl p-6 text-center text-sm text-[var(--text-muted)]">
        No hay elementos que coincidan con el filtro.
      </div>
    );
  }
  return (
    <div className="pl-glass-soft rounded-xl overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-[var(--panel-muted)]/50 text-[var(--text-muted)] uppercase tracking-wider">
            <th className="px-3 py-2 text-left">fid</th>
            <th className="px-3 py-2 text-left">Tipo</th>
            <th className="px-3 py-2 text-left">Piso</th>
            <th className="px-3 py-2 text-right">θ_CP ini (mrad)</th>
            <th className="px-3 py-2 text-right">θ_target (mrad)</th>
            <th className="px-3 py-2 text-right">θ_CP final (mrad)</th>
            <th className="px-3 py-2 text-center">Iter</th>
            <th className="px-3 py-2 text-left">Ajustes</th>
            <th className="px-3 py-2 text-center">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((e) => (
            <tr key={e.fid} className="border-t border-[var(--panel-muted)]/30">
              <td className="px-3 py-2 font-mono text-[var(--text)]">{e.fid}</td>
              <td className="px-3 py-2 text-[var(--text-muted)]">{e.kind === "column" ? "Columna" : "Viga"}</td>
              <td className="px-3 py-2 text-[var(--text-muted)]">{e.story}</td>
              <td className="px-3 py-2 text-right font-mono">{(e.theta_CP_initial * 1000).toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-mono text-[var(--text-muted)]">{(e.theta_target * 1000).toFixed(1)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold">{(e.theta_CP_final * 1000).toFixed(2)}</td>
              <td className="px-3 py-2 text-center text-[var(--text-muted)]">{e.iterations}</td>
              <td className="px-3 py-2 text-[var(--text-muted)]">
                {e.adjustments.length === 0 ? "—" : e.adjustments.join(" · ")}
              </td>
              <td className="px-3 py-2 text-center">
                <StatusBadge e={e} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="p-2 text-center text-xs text-[var(--text-muted)] italic">
          Mostrando primeros 200 de {rows.length}.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ e }: { e: ElementVerification }) {
  if (e.meets_target_final && e.meets_target_initial)
    return <span className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-[10px] font-bold">OK</span>;
  if (e.meets_target_final)
    return <span className="rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[10px] font-bold">AJUSTADO</span>;
  return <span className="rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-400 px-2 py-0.5 text-[10px] font-bold">FALLA</span>;
}
