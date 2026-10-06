"use client";

import { useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { StructuralJob } from "@/lib/structural-types";

interface Props {
  jobId:        string | null;
  pollIntervalMs?: number;
  onDone?:      (job: StructuralJob) => void;
  onError?:     (job: StructuralJob) => void;
}

/**
 * Polls `GET /analysis/jobs/{id}` cada N ms y renderiza una barra de progreso
 * con detalles del paso actual (dirección, step, drift, cortante).
 *
 * Se desmonta solo cuando el job llega a success | failed | cancelled.
 */
export default function JobProgressBar({
  jobId, pollIntervalMs = 2000, onDone, onError,
}: Props) {
  const [job, setJob] = useState<StructuralJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;

    async function poll() {
      try {
        const j = await structuralAnalysisApi.jobStatus(jobId!);
        if (cancelled) return;
        setJob(j);
        if (j.status === "success") {
          onDone?.(j);
          if (timer.current) clearInterval(timer.current);
        } else if (j.status === "failed" || j.status === "cancelled") {
          onError?.(j);
          if (timer.current) clearInterval(timer.current);
        }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    poll();
    timer.current = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [jobId, pollIntervalMs, onDone, onError]);

  if (!jobId) return null;

  if (err) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700">
        Error consultando progreso: {err}
      </div>
    );
  }
  if (!job) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)] animate-pulse">
        Iniciando análisis…
      </div>
    );
  }

  const p = job.progress ?? null;
  const pct = typeof p?.pct === "number" ? Math.max(0, Math.min(100, p.pct)) : 0;
  const stageLabel = ({
    init:     "Preparando dominio",
    gravity:  "Análisis gravitacional",
    pushover: "Pushover en curso",
    done:     "Finalizando",
  } as Record<string, string>)[p?.stage ?? ""] ?? "Analizando…";

  const statusColor =
    job.status === "success"   ? "#22c55e" :
    job.status === "failed"    ? "#ef4444" :
    job.status === "cancelled" ? "#9ca3af" :
                                  "#3b82f6";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}` }}
          />
          <span className="font-semibold text-[var(--text)]">{stageLabel}</span>
          {p?.direction && (
            <span className="text-[var(--text-muted)]">· Dir {p.direction}</span>
          )}
          {p?.pattern_type && (
            <span className="text-[var(--text-muted)]">· Patrón {p.pattern_type}</span>
          )}
        </div>
        <div className="font-mono text-[var(--text-muted)]">
          {typeof p?.step === "number" && typeof p?.total === "number"
            ? `${p.step} / ${p.total} pasos`
            : job.status}
        </div>
      </div>

      <div className="h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: statusColor }}
        />
      </div>

      {(typeof p?.drift_pct === "number" || typeof p?.base_shear_kN === "number") && (
        <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
          <div>
            <span className="text-[var(--text-muted)]">Avance:</span>{" "}
            <span className="text-[var(--text)]">{pct}%</span>
          </div>
          {typeof p?.drift_pct === "number" && (
            <div>
              <span className="text-[var(--text-muted)]">Deriva:</span>{" "}
              <span className="text-[var(--text)]">{p.drift_pct.toFixed(3)}%</span>
            </div>
          )}
          {typeof p?.base_shear_kN === "number" && (
            <div>
              <span className="text-[var(--text-muted)]">Vb:</span>{" "}
              <span className="text-[var(--text)]">{p.base_shear_kN.toFixed(1)} kN</span>
            </div>
          )}
        </div>
      )}

      {job.status === "failed" && job.error_message && (
        <div className="text-[11px] text-red-600 whitespace-pre-wrap">
          {job.error_message.slice(0, 300)}
        </div>
      )}
    </div>
  );
}
