"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { structuralAnalysisApi, structuralEditorApi } from "@/lib/structural-api";
import type {
  PushoverPatternType, StructuralJob, ModelCheckResult,
} from "@/lib/structural-types";
import JobProgressBar from "./JobProgressBar";

type SystemType = "walls" | "frames" | "mixed" | "unknown";

interface Props {
  projectId:        string;
  activeJobTypes:   Set<string>;
  lastWallJobId?:   string | null;
  lastFrameJobId?:  string | null;
  /** Si hay diseño de muros disponible — necesario sólo para sistema walls/mixed. */
  hasWallDesign?:   boolean;
  onCompleted?:     (job: StructuralJob) => void;
}

const PATTERNS: { value: PushoverPatternType; label: string; hint: string }[] = [
  { value: "triangular", label: "Triangular (altura)",  hint: "F ∝ m·z — NSR-10 A.4.3" },
  { value: "uniforme",   label: "Uniforme",             hint: "F ∝ m — ASCE 7 §12.8.3 (bound inferior)" },
  { value: "modal",      label: "Modal (primer modo)",  hint: "F ∝ φ₁·m — dominado por primer modo" },
];

const SYSTEM_LABEL: Record<SystemType, string> = {
  walls:   "Edificio de muros",
  frames:  "Edificio de pórticos",
  mixed:   "Edificio mixto (muros + pórticos)",
  unknown: "Sistema no detectado",
};


export default function UnifiedPushoverLauncher({
  projectId, activeJobTypes, lastWallJobId, lastFrameJobId,
  hasWallDesign = false, onCompleted,
}: Props) {
  const [check, setCheck] = useState<ModelCheckResult | null>(null);
  const [pattern, setPattern]       = useState<PushoverPatternType>("triangular");
  const [targetDrift, setTargetDrift] = useState<number>(2.0);
  const [incMm, setIncMm]           = useState<number>(1.0);
  const [directions, setDirections] = useState<("X" | "Y")[]>(["X", "Y"]);
  const [launching, setLaunching]   = useState<boolean>(false);
  const [error, setError]           = useState<string | null>(null);
  const [activeJobs, setActiveJobs] = useState<{ wall?: string; frame?: string }>({});

  // Detección del sistema
  useEffect(() => {
    let cancelled = false;
    structuralEditorApi.modelCheck(projectId)
      .then((c) => { if (!cancelled) setCheck(c); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [projectId]);

  const system: SystemType = useMemo(() => {
    if (!check) return "unknown";
    const hasWalls  = (check.n_walls   ?? 0) > 0;
    const hasFrames = (check.n_columns ?? 0) + (check.n_beams ?? 0) > 0;
    if (hasWalls && hasFrames) return "mixed";
    if (hasWalls)              return "walls";
    if (hasFrames)             return "frames";
    return "unknown";
  }, [check]);

  function toggleDir(d: "X" | "Y") {
    setDirections((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  const handleLaunch = useCallback(async () => {
    setError(null);
    if (directions.length === 0) {
      setError("Selecciona al menos una dirección (X o Y).");
      return;
    }
    setLaunching(true);
    try {
      const extra = {
        pattern_type:     pattern,
        target_drift_pct: targetDrift,
        inc_m:            incMm / 1000.0,
        directions,
      };
      const launched: { wall?: string; frame?: string } = {};
      if (system === "walls" || system === "mixed") {
        const j = await structuralAnalysisApi.launch(projectId, "nl_pushover", extra);
        launched.wall = j.id;
      }
      if (system === "frames" || system === "mixed") {
        const j = await structuralAnalysisApi.launch(projectId, "frame_pushover", extra);
        launched.frame = j.id;
      }
      setActiveJobs(launched);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }, [projectId, pattern, targetDrift, incMm, directions, system]);

  const wallRunning  = activeJobTypes.has("nl_pushover");
  const frameRunning = activeJobTypes.has("frame_pushover");
  const anyRunning   = wallRunning || frameRunning;

  const busyBtn = launching || anyRunning;

  // Reason-aware disabling: pórticos puros no requieren diseño de muros.
  const disabledReason: string | null = (() => {
    if (system === "unknown") {
      return "No se detectó sistema estructural. Verifica que el modelo tenga columnas/vigas o muros definidos.";
    }
    if ((system === "walls" || system === "mixed") && !hasWallDesign) {
      return "Para pushover de muros ejecuta primero el diseño RC. Pórticos sí puede correrse sin diseño si hay secciones y materiales definidos.";
    }
    return null;
  })();

  const canLaunch = !disabledReason;

  // Para la barra de progreso: priorizamos el job que acabamos de lanzar; si no,
  // el último job de cada tipo que esté en curso.
  const wallJob  = activeJobs.wall  ?? (wallRunning  ? lastWallJobId  ?? null : null);
  const frameJob = activeJobs.frame ?? (frameRunning ? lastFrameJobId ?? null : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-col">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Pushover No Lineal — Configuración
            </h4>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              Un único launcher que dispara el análisis sobre todos los sistemas estructurales presentes.
            </p>
          </div>
          <SystemBadge system={system} check={check} />
        </div>

        {disabledReason && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-800">
            ⚠ {disabledReason}
          </div>
        )}

        {/* Patrón de carga */}
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold text-[var(--text-muted)]">Patrón de carga lateral</p>
          <div className="flex gap-2 flex-wrap">
            {PATTERNS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPattern(p.value)}
                disabled={busyBtn}
                className={[
                  "px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors",
                  pattern === p.value
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
                  busyBtn ? "opacity-50 cursor-not-allowed" : "",
                ].join(" ")}
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[var(--text-muted)] italic">
            {PATTERNS.find((p) => p.value === pattern)?.hint}
          </p>
        </div>

        {/* Parámetros numéricos */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-[10px]">
            <span className="text-[var(--text-muted)] font-semibold">Deriva objetivo (%)</span>
            <input
              type="number" step={0.1} min={0.5} max={10}
              value={targetDrift}
              onChange={(e) => setTargetDrift(parseFloat(e.target.value) || 2.0)}
              disabled={busyBtn}
              className="px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text)] font-mono text-[11px] border border-[var(--border)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px]">
            <span className="text-[var(--text-muted)] font-semibold">Δ paso (mm)</span>
            <input
              type="number" step={0.1} min={0.1} max={10}
              value={incMm}
              onChange={(e) => setIncMm(parseFloat(e.target.value) || 1.0)}
              disabled={busyBtn}
              className="px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text)] font-mono text-[11px] border border-[var(--border)]"
            />
          </label>
          <div className="flex flex-col gap-1 text-[10px]">
            <span className="text-[var(--text-muted)] font-semibold">Direcciones</span>
            <div className="flex gap-1">
              {(["X", "Y"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDir(d)}
                  disabled={busyBtn}
                  className={[
                    "flex-1 py-1 rounded text-[11px] font-mono font-semibold transition-colors",
                    directions.includes(d)
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--text-muted)]",
                    busyBtn ? "opacity-50 cursor-not-allowed" : "",
                  ].join(" ")}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-300 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end">
          <button
            onClick={handleLaunch}
            disabled={busyBtn || !canLaunch}
            className="px-4 py-2 rounded-md text-xs font-semibold bg-[var(--accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            {launching ? "Lanzando…"
              : anyRunning ? "Calculando…"
              : system === "mixed" ? "Ejecutar pushover (muros + pórticos)"
              : system === "walls" ? "Ejecutar pushover de muros"
              : system === "frames" ? "Ejecutar pushover de pórticos"
              : "Ejecutar pushover"}
          </button>
        </div>
      </div>

      {/* Barras de progreso en vivo para cada job activo */}
      {wallJob && (
        <JobProgressBar jobId={wallJob} pollIntervalMs={2000} onDone={onCompleted} onError={onCompleted} />
      )}
      {frameJob && (
        <JobProgressBar jobId={frameJob} pollIntervalMs={2000} onDone={onCompleted} onError={onCompleted} />
      )}
    </div>
  );
}


function SystemBadge({ system, check }: { system: SystemType; check: ModelCheckResult | null }) {
  const palette: Record<SystemType, string> = {
    walls:   "#2563eb",
    frames:  "#16a34a",
    mixed:   "#9333ea",
    unknown: "#94a3b8",
  };
  const color = palette[system];
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1 rounded-full text-[10px] font-semibold"
      style={{ background: `${color}22`, color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span>{SYSTEM_LABEL[system]}</span>
      {check && (
        <span className="text-[var(--text-muted)] font-mono font-normal">
          {check.n_walls ? ` · ${check.n_walls} muros` : ""}
          {check.n_columns ? ` · ${check.n_columns} col` : ""}
          {check.n_beams ? ` · ${check.n_beams} vigas` : ""}
        </span>
      )}
    </div>
  );
}
