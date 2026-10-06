"use client";

import { useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type {
  PushoverPatternType, StructuralJob,
} from "@/lib/structural-types";
import JobProgressBar from "./JobProgressBar";

interface Props {
  projectId: string;
  /** Si ya hay un job en curso, pasa el id para engancharse al polling. */
  activeJobId?: string | null;
  /** Callback al finalizar — ideal para disparar refetch del resultado. */
  onCompleted?: (job: StructuralJob) => void;
}

const PATTERNS: {
  value: PushoverPatternType; label: string; hint: string;
}[] = [
  { value: "triangular", label: "Triangular (altura)",
    hint: "F ∝ m·z — NSR-10 A.4.3 clásico" },
  { value: "uniforme",   label: "Uniforme",
    hint: "F igual por piso — ASCE 7 §12.8.3 (bound inferior)" },
  { value: "modal",      label: "Modal (primer modo)",
    hint: "F ∝ φ₁·m — recomendado si la respuesta es dominada por el primer modo" },
];


export default function NLFramePushoverLauncher({
  projectId, activeJobId, onCompleted,
}: Props) {
  const [pattern, setPattern]       = useState<PushoverPatternType>("triangular");
  const [targetDrift, setTargetDrift] = useState<number>(2.0);
  const [incMm, setIncMm]           = useState<number>(1.0);
  const [directions, setDirections] = useState<("X" | "Y")[]>(["X", "Y"]);
  const [launching, setLaunching]   = useState<boolean>(false);
  const [jobId, setJobId]           = useState<string | null>(activeJobId ?? null);
  const [error, setError]           = useState<string | null>(null);

  async function handleLaunch() {
    setError(null);
    if (directions.length === 0) {
      setError("Selecciona al menos una dirección (X o Y).");
      return;
    }
    setLaunching(true);
    try {
      const job = await structuralAnalysisApi.launch(projectId, "frame_pushover", {
        pattern_type:     pattern,
        target_drift_pct: targetDrift,
        inc_m:            incMm / 1000.0,
        directions,
      });
      setJobId(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }

  function toggleDir(d: "X" | "Y") {
    setDirections((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  const busy = launching || (jobId !== null);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Configurar pushover no lineal
          </h4>
        </div>

        {/* Patrón de carga */}
        <div className="flex flex-col gap-2">
          <label className="text-[11px] font-semibold text-[var(--text)] uppercase tracking-wider">
            Patrón de carga lateral
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PATTERNS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPattern(p.value)}
                disabled={busy}
                className={[
                  "text-left rounded-lg border p-3 transition-colors",
                  pattern === p.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--text-muted)]",
                  busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
              >
                <div className="text-xs font-semibold text-[var(--text)]">{p.label}</div>
                <div className="text-[10px] text-[var(--text-muted)] mt-1">{p.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Parámetros numéricos */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">
              Deriva objetivo (%)
            </label>
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.1}
              value={targetDrift}
              disabled={busy}
              onChange={(e) => setTargetDrift(parseFloat(e.target.value) || 2.0)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">
              Paso de desplazamiento (mm)
            </label>
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={incMm}
              disabled={busy}
              onChange={(e) => setIncMm(parseFloat(e.target.value) || 1.0)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">
              Direcciones
            </label>
            <div className="flex gap-2">
              {(["X", "Y"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDir(d)}
                  disabled={busy}
                  className={[
                    "px-3 py-1.5 rounded text-xs font-semibold border transition-colors",
                    directions.includes(d)
                      ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                      : "bg-[var(--surface)] text-[var(--text-muted)] border-[var(--border)]",
                    busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <p className="text-[10px] text-[var(--text-muted)] italic">
            Fibras Concrete02 Mander + Steel02, HingeRadau en extremos,
            diafragma rígido por piso.
          </p>
          <button
            onClick={handleLaunch}
            disabled={busy}
            className={[
              "px-4 py-1.5 rounded-md text-sm font-semibold transition-colors",
              busy
                ? "bg-[var(--surface-2)] text-[var(--text-muted)] cursor-not-allowed"
                : "bg-[var(--accent)] text-white hover:brightness-110",
            ].join(" ")}
          >
            {launching ? "Lanzando…" : jobId ? "En curso…" : "Correr análisis"}
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </div>
        )}
      </div>

      {jobId && (
        <JobProgressBar
          jobId={jobId}
          pollIntervalMs={2000}
          onDone={(j) => { onCompleted?.(j); setJobId(null); }}
          onError={(j) => {
            setError(j.error_message ?? "El análisis falló");
            setJobId(null);
          }}
        />
      )}
    </div>
  );
}
