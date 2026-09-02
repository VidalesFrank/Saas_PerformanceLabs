"use client";

import { useEffect, useState, useCallback } from "react";
import type { ModelCheckResult, ModelCheckIssue } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  onSelectElements?: (ids: string[]) => void;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: ok ? "var(--color-success)" : "var(--color-danger)" }}
    />
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-2">
        <StatusDot ok={ok} />
        <span className="text-xs text-text">{label}</span>
      </div>
      {detail && (
        <span className="text-[11px] font-mono" style={{ color: ok ? "var(--color-success)" : "var(--color-danger)" }}>
          {detail}
        </span>
      )}
    </div>
  );
}

function IssueCard({ issue, onSelect }: { issue: ModelCheckIssue; onSelect?: (ids: string[]) => void }) {
  const isError = issue.severity === "error";
  const ids = issue.element_ids ?? [];
  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{
        borderColor: isError ? "var(--color-danger)" : "var(--color-warning)",
        background: isError ? "rgba(239,68,68,0.06)" : "rgba(245,158,11,0.06)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5"
            style={{ color: isError ? "var(--color-danger)" : "var(--color-warning)" }}>
            {issue.code}
          </p>
          <p className="text-xs text-text leading-snug">{issue.message}</p>
        </div>
        {ids.length > 0 && onSelect && (
          <button
            onClick={() => onSelect(ids)}
            className="text-[10px] px-2 py-0.5 rounded border whitespace-nowrap flex-shrink-0 transition-colors"
            style={{
              borderColor: isError ? "var(--color-danger)" : "var(--color-warning)",
              color: isError ? "var(--color-danger)" : "var(--color-warning)",
            }}
          >
            Ver ({ids.length})
          </button>
        )}
      </div>
    </div>
  );
}

export default function ModelHealthPanel({ projectId, onSelectElements }: Props) {
  const [result, setResult] = useState<ModelCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await structuralEditorApi.modelCheck(projectId);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al ejecutar la verificación");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { runCheck(); }, [runCheck]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0 flex items-center justify-between">
        <span className="text-xs font-semibold text-text">Model Check</span>
        <button
          onClick={runCheck}
          disabled={loading}
          className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-text-muted hover:text-text hover:border-accent transition-colors disabled:opacity-40"
        >
          {loading ? "Verificando…" : "↺ Actualizar"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        {loading && !result && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-text-muted">Verificando modelo…</p>
          </div>
        )}

        {result && (
          <>
            {/* Status general */}
            <div className="rounded-lg border px-3 py-3"
              style={{
                borderColor: result.ready_for_analysis ? "var(--color-success)" : "var(--color-danger)",
                background: result.ready_for_analysis ? "rgba(16,185,129,0.06)" : "rgba(239,68,68,0.06)",
              }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{result.ready_for_analysis ? "✓" : "✗"}</span>
                <span className="text-sm font-semibold text-text">
                  {result.ready_for_analysis ? "Listo para análisis" : "No listo para análisis"}
                </span>
              </div>
              <p className="text-[11px] text-text-muted">
                {result.n_errors} error(es) · {result.n_warnings} advertencia(s)
              </p>
            </div>

            {/* Estadísticas del modelo */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
                Estadísticas del modelo
              </p>
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 grid grid-cols-2 gap-x-4">
                {[
                  ["Columnas",  result.n_columns],
                  ["Vigas",     result.n_beams],
                  ["Muros",     result.n_walls],
                  ["Losas",     result.n_slabs],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex justify-between py-1 border-b border-border/30 last:border-0 col-span-1">
                    <span className="text-[11px] text-text-muted">{label}</span>
                    <span className="text-[11px] font-mono text-text">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Checks */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
                Verificaciones
              </p>
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-1">
                <CheckRow label="Geometría (longitud cero)"
                  ok={result.geometry_ok}
                  detail={result.n_zero_length > 0 ? `${result.n_zero_length} elem.` : "OK"} />
                <CheckRow label="Conectividad (nodos aislados)"
                  ok={result.connectivity_ok}
                  detail={result.n_isolated_nodes > 0 ? `${result.n_isolated_nodes} nodos` : "OK"} />
                <CheckRow label="Materiales en secciones"
                  ok={result.materials_ok}
                  detail={result.n_sections_no_material > 0 ? `${result.n_sections_no_material} secc.` : "OK"} />
                <CheckRow label="Secciones en frames"
                  ok={result.sections_ok}
                  detail={result.n_frames_no_section > 0 ? `${result.n_frames_no_section} elem.` : "OK"} />
                <CheckRow label="Masas por diafragma"
                  ok={result.loads_ok}
                  detail={result.loads_ok ? "OK" : "Sin masas"} />
              </div>
            </div>

            {/* Errores */}
            {result.errors.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
                  Errores ({result.errors.length})
                </p>
                <div className="flex flex-col gap-2">
                  {result.errors.map((issue, i) => (
                    <IssueCard key={i} issue={issue} onSelect={onSelectElements} />
                  ))}
                </div>
              </div>
            )}

            {/* Advertencias */}
            {result.warnings.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
                  Advertencias ({result.warnings.length})
                </p>
                <div className="flex flex-col gap-2">
                  {result.warnings.map((issue, i) => (
                    <IssueCard key={i} issue={issue} onSelect={onSelectElements} />
                  ))}
                </div>
              </div>
            )}

            {result.errors.length === 0 && result.warnings.length === 0 && (
              <div className="text-center py-4">
                <p className="text-xs text-text-muted">✓ Sin problemas detectados</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
