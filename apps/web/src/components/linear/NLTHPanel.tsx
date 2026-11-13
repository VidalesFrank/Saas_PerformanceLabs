"use client";

/**
 * Panel de Análisis Cronológico No Lineal (NLTHA / Time-History).
 *
 * Flujo:
 *   1. Usuario sube 2 archivos de registro (PEER .at2, FEMA txt, CSV t,a).
 *   2. Backend autodetecta dt, PGA, unidades y devuelve preview.
 *   3. Panel pre-rellena dtrec y units_hint. Permite escalar.
 *   4. Launch del job → polling.
 *   5. Panel resultados: δ_techo·t, Vb·t, envolvente derivas, envolvente
 *      aceleraciones + resumen de daño (rótulas ASCE 41 / pieres Park-Ang).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { structuralAnalysisApi, elementThresholdsApi } from "@/lib/structural-api";
import type { ElementDemandResult } from "@/lib/structural-api";
import type {
  NLTHResult, NLTHUploadResult, StructuralJob,
  NLTHDamageHinges, NLTHDamagePiers, NLTHThresholdsMeta, ThresholdKey,
  NLTHJobMeta,
} from "@/lib/structural-types";
import { useBuildingWeightKN } from "./use-building-weight";
import ElementThresholdsPanel from "./ElementThresholdsPanel";
import LocalEventsPanel, {
  buildEventMarkers, buildEventLegendTraces,
} from "./LocalEventsPanel";
import RepairPlanPanel from "./RepairPlanPanel";
import NLTHFinalState3D from "./NLTHFinalState3D";
import { DamageThresholdsPanel } from "./DamageThresholdsPanel";
import { AnalysisHealthBanner } from "./AnalysisHealthBanner";
import { RecordValidationCard } from "./RecordValidationCard";
import { FEMALibrarySelector } from "./FEMALibrarySelector";
import { usePlotly } from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyConfigPremium } from "@/lib/plotly-theme";
import type { LocalEventsPayload } from "@/lib/structural-types";

interface Props {
  projectId: string;
  system:    "walls" | "frames" | "mixed" | "unknown";
}

type System = "walls" | "frames";
type Unit   = "g" | "mps2" | "cm/s2";

export default function NLTHPanel({ projectId, system: detected }: Props) {
  // Archivos y previews
  const [uploadX, setUploadX] = useState<NLTHUploadResult | null>(null);
  const [uploadY, setUploadY] = useState<NLTHUploadResult | null>(null);
  const [uploading, setUploading] = useState<"X" | "Y" | null>(null);

  // Parámetros
  const [system, setSystem]           = useState<System>(detected === "walls" ? "walls" : "frames");
  const [dtrec, setDtrec]             = useState<number>(0.02);
  const [dtAnalysis, setDtAnalysis]   = useState<number>(0.005);
  const [damping, setDamping]         = useState<number>(0.05);
  const [scale, setScale]             = useState<number>(1.0);
  const [units, setUnits]             = useState<Unit>("g");
  const [duration, setDuration]       = useState<string>("");

  const [job, setJob]                 = useState<StructuralJob | null>(null);
  const [result, setResult]           = useState<NLTHResult | null>(null);
  // Historial de análisis NLTH del proyecto. Cada corrida guarda su carpeta
  // `nlth/<job_id>/` → podemos navegar entre análisis sin re-correr.
  const [jobs, setJobs]               = useState<NLTHJobMeta[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [loadingJob, setLoadingJob]   = useState<string | null>(null);
  // Modo preview: NLTHResult cargado desde un .json externo (fuera de DB).
  // Útil para revisar análisis de otros proyectos, backups, o archivados
  // offline sin tener que subirlos al servidor.
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const [demand, setDemand]           = useState<ElementDemandResult | null>(null);
  const [launching, setLaunching]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [thresholdsMeta, setThresholdsMeta] = useState<NLTHThresholdsMeta | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  // Timestamp del lanzamiento (ms epoch) — para computar wall-time y ETA en vivo.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick]     = useState<number>(() => Date.now());
  // Stall detector (Ola 3): último pct observado + timestamp del último cambio.
  // Si el análisis no avanza >30s se pinta alerta roja y aparece botón cancelar.
  const [lastSeenPct, setLastSeenPct]     = useState<number>(0);
  const [lastPctChangeAt, setLastPctChangeAt] = useState<number>(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const W_kN = useBuildingWeightKN(projectId);

  // Fuente del registro: carga manual vs biblioteca FEMA (persistido local).
  const [source, setSource] = useState<"upload" | "fema">(() => {
    if (typeof window === "undefined") return "upload";
    return (localStorage.getItem(`nlth-source:${projectId}`) as "upload" | "fema") ?? "upload";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(`nlth-source:${projectId}`, source);
    }
  }, [source, projectId]);

  // T1 del modal (para escalado FEMA) + flag si hay espectral para modo nsr10
  const [T1Modal,  setT1Modal]  = useState<number | null>(null);
  const [T1ModalY, setT1ModalY] = useState<number | null>(null);
  const [nsr10Available, setNsr10Available] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    structuralAnalysisApi.getModalResult(projectId)
      .then((r) => {
        if (cancelled) return;
        setT1Modal(typeof r?.T1_x === "number" ? r.T1_x : (typeof r?.T1 === "number" ? r.T1 : null));
        setT1ModalY(typeof r?.T1_y === "number" ? r.T1_y : null);
      })
      .catch(() => { /* silencioso — modal puede no existir aún */ });
    structuralAnalysisApi.getSpectralResult(projectId)
      .then((r) => { if (!cancelled) setNsr10Available(!!r?.spectrum); })
      .catch(() => { /* silencioso */ });
    return () => { cancelled = true; };
  }, [projectId]);

  // Refs de los plots
  const previewXRef   = useRef<HTMLDivElement>(null);
  const previewYRef   = useRef<HTMLDivElement>(null);
  const roofRef       = useRef<HTMLDivElement>(null);
  const vbRef         = useRef<HTMLDivElement>(null);
  const driftRef      = useRef<HTMLDivElement>(null);
  const accelRef      = useRef<HTMLDivElement>(null);
  const amplifRef     = useRef<HTMLDivElement>(null);
  const hysteresisRef = useRef<HTMLDivElement>(null);
  const orbitRef      = useRef<HTMLDivElement>(null);

  // Carga resultado existente al montar + registros ya subidos (para que el
  // botón "Lanzar NLTHA" se habilite sin exigir re-subir archivos).
  useEffect(() => {
    let cancelled = false;
    structuralAnalysisApi.getNLTHResult(projectId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => {});
    elementThresholdsApi.getElementDemand(projectId)
      .then((d) => { if (!cancelled) setDemand(d); })
      .catch(() => {});
    structuralAnalysisApi.listNLTHRecords(projectId)
      .then((r) => {
        if (cancelled) return;
        if (r.X) setUploadX(r.X);
        if (r.Y) setUploadY(r.Y);
      })
      .catch(() => {});
    structuralAnalysisApi.listNLTHJobs(projectId)
      .then((js) => {
        if (cancelled) return;
        setJobs(js);
        if (js.length > 0) setActiveJobId(js[0].job_id);  // más reciente
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // Carga un job histórico y lo pone como vista activa (no toca el shim del
  // "último"; el usuario puede navegar libremente entre análisis).
  const openHistoricalJob = useCallback(async (jobId: string) => {
    setLoadingJob(jobId);
    setError(null);
    try {
      const r = await structuralAnalysisApi.getNLTHResultByJob(projectId, jobId);
      setResult(r);
      setActiveJobId(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingJob(null);
    }
  }, [projectId]);

  // Fija este job como "el último" en results/ → afecta verificador, export y
  // diagnóstico por elemento (que leen la copia tradicional).
  const activateHistoricalJob = useCallback(async (jobId: string) => {
    try {
      await structuralAnalysisApi.activateNLTHJob(projectId, jobId);
      // Refrescar el result (es idéntico al que ya se muestra, pero asegura
      // que verificador/export operen con este job).
      const r = await structuralAnalysisApi.getNLTHResult(projectId);
      setResult(r);
      setActiveJobId(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  // ── Export / Import JSON portable (Fase 2) ───────────────────────────────

  /** Descarga un JSON autocontenido del análisis seleccionado. Envuelve el
   *  NLTHResult en un sobre con metadata y schema_version para trazabilidad
   *  y para que el importador lo reconozca. */
  const downloadBlob = useCallback((data: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }, []);

  const buildExportBundle = useCallback(
    (res: NLTHResult, source: "historical_job" | "live", jobMeta?: NLTHJobMeta) => ({
      export_meta: {
        schema_version: "1.0",
        exporter:       "PerformanceLabs NLTH",
        exported_at:    new Date().toISOString(),
        project_id:     projectId,
        job_id:         jobMeta?.job_id ?? null,
        source,
        record_x:       jobMeta?.record_x_file ?? (res as NLTHResult & { record_x_file?: string }).record_x_file ?? null,
        record_y:       jobMeta?.record_y_file ?? (res as NLTHResult & { record_y_file?: string }).record_y_file ?? null,
        scale:          jobMeta?.scale ?? null,
      },
      result: res,
    }),
    [projectId],
  );

  const exportHistoricalJob = useCallback(
    async (jobMeta: NLTHJobMeta) => {
      try {
        const r = await structuralAnalysisApi.getNLTHResultByJob(projectId, jobMeta.job_id);
        const bundle = buildExportBundle(r, "historical_job", jobMeta);
        const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
        const ts   = jobMeta.computed_at
          ? jobMeta.computed_at.slice(0, 19).replace(/[:T]/g, "-")
          : "unknown-date";
        const fname = `nlth_${safe(jobMeta.record_x_file || "analysis")}_${ts}.json`;
        downloadBlob(bundle, fname);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId, buildExportBundle, downloadBlob],
  );

  /** Carga un NLTHResult desde un .json en disco y lo pinta en modo preview.
   *  Acepta dos formatos: (a) bundle con `export_meta` + `result`, o (b) un
   *  NLTHResult directo (por si alguien exportó manualmente). */
  const importJSONFromFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.onload = (ev) => {
      try {
        const raw = String(ev.target?.result ?? "");
        const parsed = JSON.parse(raw);
        // Detectar formato
        let res: NLTHResult;
        if (parsed && typeof parsed === "object" && parsed.result && parsed.export_meta) {
          res = parsed.result as NLTHResult;
        } else if (parsed && typeof parsed === "object" && parsed.envelope) {
          // NLTHResult crudo
          res = parsed as NLTHResult;
        } else {
          throw new Error(
            "El archivo no parece un resultado NLTH. Espero un objeto con " +
            "`envelope` o un bundle `{export_meta, result}`.",
          );
        }
        setResult(res);
        setPreviewFilename(file.name);
        setActiveJobId(null);
        setError(null);
        // Scroll al tope de los resultados para que se vea el banner
        setTimeout(() => window.scrollTo({ top: 300, behavior: "smooth" }), 100);
      } catch (e) {
        setError(e instanceof Error ? e.message : "JSON inválido.");
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const exitPreviewMode = useCallback(async () => {
    setPreviewFilename(null);
    // Volver al último job del proyecto
    try {
      const freshJobs = await structuralAnalysisApi.listNLTHJobs(projectId);
      setJobs(freshJobs);
      if (freshJobs.length > 0) {
        await openHistoricalJob(freshJobs[0].job_id);
      } else {
        setResult(null);
        setActiveJobId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, openHistoricalJob]);

  // Borra un job del historial. Si borras el activo, limpiamos el panel.
  const deleteHistoricalJob = useCallback(async (jobId: string) => {
    if (!window.confirm("¿Borrar este análisis NLTH del historial?")) return;
    try {
      await structuralAnalysisApi.deleteNLTHJob(projectId, jobId);
      const freshJobs = await structuralAnalysisApi.listNLTHJobs(projectId);
      setJobs(freshJobs);
      if (activeJobId === jobId) {
        if (freshJobs.length > 0) {
          await openHistoricalJob(freshJobs[0].job_id);
        } else {
          setResult(null);
          setActiveJobId(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, activeJobId, openHistoricalJob]);

  // Carga meta de umbrales de daño cuando hay resultado (sólo frames; muros no
  // usan sect_def). Si no hay result o es muro, el endpoint responde 404 y
  // dejamos meta=null para que el panel no se renderice.
  useEffect(() => {
    if (!result || result.meta?.eletype !== "frame") {
      setThresholdsMeta(null);
      return;
    }
    let cancelled = false;
    structuralAnalysisApi.getNLTHThresholdsMeta(projectId)
      .then((m) => { if (!cancelled) setThresholdsMeta(m); })
      .catch(() => { if (!cancelled) setThresholdsMeta(null); });
    return () => { cancelled = true; };
  }, [projectId, result]);

  // Auto-dispara la clasificación de modo de falla cuando hay result de frames
  // y no se ha calculado aún. El endpoint es puro post-process (segundos).
  useEffect(() => {
    if (!result || result.meta?.eletype !== "frame") return;
    if (result.failure_modes) return;   // ya está calculado
    let cancelled = false;
    structuralAnalysisApi.recomputeNLTHFailureModes(projectId)
      .then(async () => {
        if (cancelled) return;
        const fresh = await structuralAnalysisApi.getNLTHResult(projectId);
        if (!cancelled) setResult(fresh);
      })
      .catch(() => { /* silencioso: si falta element_thresholds, no se dibuja */ });
    return () => { cancelled = true; };
  }, [projectId, result]);

  const recomputeEvents = useCallback(async (
    overrides: Partial<Record<ThresholdKey, number>>,
  ) => {
    if (recomputing) return;
    setRecomputing(true);
    try {
      const r = await structuralAnalysisApi.recomputeNLTHEvents(projectId, overrides);
      const fresh = await structuralAnalysisApi.getNLTHResult(projectId);
      setResult(fresh);
      setThresholdsMeta((prev) => prev ? {
        ...prev,
        user_override: r.events.thresholds_user_override ?? {},
      } : prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error recalculando estados de daño.");
    } finally {
      setRecomputing(false);
    }
  }, [projectId, recomputing]);

  // Polling del job
  useEffect(() => {
    if (!job || job.status === "success" || job.status === "failed" || job.status === "cancelled") return;
    const id = setInterval(async () => {
      try {
        const fresh = await structuralAnalysisApi.jobStatus(job.id);
        setJob(fresh);
        if (fresh.status === "success") {
          clearInterval(id);
          const r = await structuralAnalysisApi.getNLTHResult(projectId);
          setResult(r);
          elementThresholdsApi.getElementDemand(projectId)
            .then(setDemand).catch(() => {});
          // Refrescar historial — el job recién completado debe aparecer.
          structuralAnalysisApi.listNLTHJobs(projectId)
            .then((js) => {
              setJobs(js);
              if (js.length > 0) setActiveJobId(js[0].job_id);
            })
            .catch(() => {});
        }
        if (fresh.status === "failed" || fresh.status === "cancelled") {
          clearInterval(id);
          setError(fresh.error_message ?? "El NLTHA falló.");
        }
      } catch (e) {
        clearInterval(id);
        setError(e instanceof Error ? e.message : "Error consultando el job.");
      }
    }, 3000);
    return () => clearInterval(id);
  }, [job, projectId]);

  const upload = useCallback(async (dir: "X" | "Y", file: File) => {
    setUploading(dir);
    setError(null);
    try {
      const r = await structuralAnalysisApi.uploadNLTHRecord(projectId, dir, file);
      if (dir === "X") setUploadX(r); else setUploadY(r);
      // Auto-rellenar dt/units con lo detectado (X toma prioridad; Y refuerza si falta)
      if (r.dt_detected && r.dt_detected > 0)  setDtrec(r.dt_detected);
      if (r.units_hint)                        setUnits(r.units_hint);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error subiendo el registro.");
    } finally {
      setUploading(null);
    }
  }, [projectId]);

  const launch = useCallback(async () => {
    if (!uploadX?.path || !uploadY?.path) {
      setError("Debes subir los registros X e Y antes de lanzar.");
      return;
    }
    setLaunching(true); setError(null); setResult(null);
    setStartedAt(Date.now());
    try {
      const extra: Record<string, unknown> = {
        system,
        record_x_path: uploadX.path,
        record_y_path: uploadY.path,
        dtrec:         dtrec,
        dt_analysis:   dtAnalysis,
        damping:       damping,
        scale:         scale,
        record_units:  units,
      };
      if (duration.trim()) extra.duration = Number(duration);
      const j = await structuralAnalysisApi.launch(projectId, "nlth", extra);
      setJob(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error lanzando el job.");
    } finally {
      setLaunching(false);
    }
  }, [projectId, uploadX, uploadY, system, dtrec, dtAnalysis, damping, scale, units, duration]);

  // Preview X
  // Gatekeepear los plots hasta que Plotly esté disponible (cargado vía CDN
  // en app/(app)/layout.tsx). Si pasamos null a los hooks mientras carga, el
  // useEffect interno hace early return; cuando plotlyReady cambia a true,
  // React re-renderiza, los hooks reciben el `result` real y disparan newPlot
  // con Plotly ya definido. Fix del bug de 2026-11-04: al persistir la última
  // sección activa, se podía aterrizar en NLTH sin que Plotly hubiera cargado.
  const plotlyReady = usePlotly();
  const rr = plotlyReady ? result : null;
  usePreviewPlot(previewXRef, plotlyReady ? uploadX?.preview : undefined, "#2563eb");
  usePreviewPlot(previewYRef, plotlyReady ? uploadY?.preview : undefined, "#16a34a");
  // Resultados
  useRoofPlot(roofRef, rr, rr?.events ?? null);
  useVbPlot(vbRef, rr, W_kN, rr?.events ?? null);
  useDriftPlot(driftRef, rr);
  useAccelPlot(accelRef, rr);
  useAmplificationPlot(amplifRef, rr);
  useHysteresisPlot(hysteresisRef, rr);
  useOrbitPlot(orbitRef, rr);

  const running  = job && (job.status === "pending" || job.status === "running");
  const progress = (job?.progress ?? {}) as { stage?: string; pct?: number; t?: number };

  // Trackear cambios de pct para el stall detector
  useEffect(() => {
    if (!running) return;
    const pct = typeof progress.pct === "number" ? progress.pct : 0;
    if (Math.abs(pct - lastSeenPct) > 0.01) {
      setLastSeenPct(pct);
      setLastPctChangeAt(Date.now());
    }
  }, [progress.pct, running, lastSeenPct]);
  // Al cambiar de job, resetear
  useEffect(() => {
    setLastSeenPct(0);
    setLastPctChangeAt(Date.now());
  }, [job?.id]);

  const stalledSec = running ? (nowTick - lastPctChangeAt) / 1000 : 0;
  const isStalled  = running && stalledSec > 30 && (progress.pct ?? 0) < 99.5;

  const handleCancel = useCallback(async () => {
    if (!job || canceling) return;
    if (!window.confirm("¿Cancelar el análisis? El proceso OpenSees recibirá SIGKILL y no podrá recuperarse.")) return;
    setCanceling(true);
    try {
      await structuralAnalysisApi.cancel(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cancelando el job.");
    } finally {
      setCanceling(false);
    }
  }, [job, canceling]);

  const sameDt = uploadX?.dt_detected && uploadY?.dt_detected &&
                 Math.abs(uploadX.dt_detected - uploadY.dt_detected) > 1e-6;

  // Reloj: refresca cada segundo mientras hay job corriendo (para ETA en vivo).
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Métricas en vivo de progreso.
  const liveMetrics = (() => {
    if (!running || !startedAt) return null;
    const elapsedMs = nowTick - startedAt;
    const elapsedS  = Math.max(0, elapsedMs / 1000);
    const pct       = typeof progress.pct === "number" ? progress.pct : 0;
    const tSim      = typeof progress.t   === "number" ? progress.t   : 0;
    // ETA solo tiene sentido con pct > ~2 para no explotar al inicio.
    const etaS = pct > 2
      ? Math.max(0, (elapsedS * (100 - pct)) / pct)
      : null;
    const ratio = tSim > 0.1 ? elapsedS / tSim : null;
    return { elapsedS, etaS, ratio, pct, tSim };
  })();

  const fmtDuration = (s: number | null | undefined): string => {
    if (s == null || !Number.isFinite(s)) return "—";
    if (s < 60)    return `${s.toFixed(0)} s`;
    if (s < 3600)  return `${Math.floor(s / 60)}m ${Math.floor(s % 60).toString().padStart(2, "0")}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Banner de modo preview (JSON externo cargado) ─────────────────── */}
      {previewFilename && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded bg-amber-500 text-white">
              Vista previa
            </span>
            <span className="text-xs text-[var(--text)] truncate">
              Análisis cargado desde <code className="font-mono text-[var(--text-muted)]">{previewFilename}</code> — no está guardado en este proyecto.
            </span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={async () => {
                if (!result) return;
                try {
                  const r = await structuralAnalysisApi.importNLTHBundle(projectId, {
                    export_meta: { exporter: "NLTHPanel preview", exported_at: new Date().toISOString() },
                    result,
                  });
                  // Refrescar historial + fijar el job importado
                  const list = await structuralAnalysisApi.listNLTHJobs(projectId);
                  setJobs(list);
                  setActiveJobId(r.job_id);
                  setPreviewFilename(null);
                  alert(r.message);
                } catch (e) {
                  alert(`Error importando: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              className="text-xs px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
              title="Persiste el bundle JSON como un job real del proyecto"
            >
              Guardar como nuevo análisis
            </button>
            <button
              type="button"
              onClick={exitPreviewMode}
              className="text-xs px-3 py-1 rounded bg-[var(--panel-muted)] hover:bg-[var(--surface-2)] text-[var(--text)]"
            >
              Volver al proyecto
            </button>
          </div>
        </div>
      )}

      {/* Input oculto para importar JSON externos. */}
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importJSONFromFile(f);
          e.target.value = "";
        }}
      />

      {/* ── Launcher ──────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
              Análisis Cronológico No Lineal
            </h3>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              Newmark adaptativo β=0.25 γ=0.5. Registro bidireccional X+Y como
              UniformExcitation. Soporta <b>PEER NGA .at2</b>, <b>FEMA txt</b>, <b>CSV</b>.
              dt y unidades se autodetectan del header cuando están disponibles.
            </p>
          </div>
          <SystemBadge detected={detected} />
        </div>

        {/* Fuente del registro: subir archivo vs biblioteca FEMA P-695 */}
        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mr-2">
            Fuente del registro
          </span>
          <button
            onClick={() => setSource("upload")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              source === "upload"
                ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                : "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)] hover:bg-[var(--surface)]"
            }`}
          >
            Cargar archivos propios
          </button>
          <button
            onClick={() => setSource("fema")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              source === "fema"
                ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                : "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)] hover:bg-[var(--surface)]"
            }`}
          >
            Biblioteca FEMA P-695 (22 pares)
          </button>
        </div>

        {source === "upload" ? (
          /* Uploads + previews */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <RecordUpload dir="X" upload={uploadX} uploading={uploading === "X"}
              onFile={(f) => f && upload("X", f)} previewRef={previewXRef} />
            <RecordUpload dir="Y" upload={uploadY} uploading={uploading === "Y"}
              onFile={(f) => f && upload("Y", f)} previewRef={previewYRef} />
          </div>
        ) : (
          <FEMALibrarySelector
            projectId={projectId}
            T1_x={T1Modal}
            T1_y={T1ModalY}
            nsr10Available={!!nsr10Available}
            onPairApplied={(ux, uy, info) => {
              setUploadX(ux); setUploadY(uy);
              // Si el backend calculó un factor de escala, lo reflejamos en el panel.
              if (typeof info.scale === "number") setScale(info.scale);
              if (ux.dt_detected) setDtrec(ux.dt_detected);
              setUnits("g");
            }}
          />
        )}

        {sameDt && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            ⚠ dt detectado difiere entre X e Y ({uploadX?.dt_detected?.toFixed(5)}s vs {uploadY?.dt_detected?.toFixed(5)}s).
            El análisis usa un único dt — verifica que los registros sean compatibles.
          </div>
        )}

        {/* Validación visual de la configuración del registro (Ola 3) */}
        <RecordValidationCard
          uploadX={uploadX} uploadY={uploadY}
          dtrec={dtrec} units={units} scale={scale}
        />

        {/* Parámetros */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 pt-1">
          <ParamSelect label="Sistema" value={system}
            onChange={(v) => setSystem(v as System)}
            options={[["walls", "Muros"], ["frames", "Pórticos"]]}
            disabled={detected !== "mixed" && detected !== "unknown"}
          />
          <ParamSelect label="Unidades" value={units}
            onChange={(v) => setUnits(v as Unit)}
            options={[["g", "g"], ["mps2", "m/s²"], ["cm/s2", "cm/s²"]]}
          />
          <ParamNumber label="dt registro (s)" value={dtrec}  onChange={setDtrec} step={0.001} min={0.001} />
          <ParamNumber label="dt análisis (s)" value={dtAnalysis} onChange={setDtAnalysis} step={0.001} min={0.0005} />
          <ParamNumber label="Escala" value={scale} onChange={setScale} step={0.1} min={0.1} />
          <ParamNumber label="ζ Rayleigh" value={damping} onChange={setDamping} step={0.01} min={0} max={0.2} />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex flex-col gap-1 w-56">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Duración (s) — vacío = completo
            </span>
            <input type="number" step="0.1" min={0}
              value={duration} onChange={(e) => setDuration(e.target.value)}
              className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono"
            />
          </label>
          <button
            onClick={launch}
            disabled={launching || !!running || !uploadX?.path || !uploadY?.path}
            className="ml-auto px-4 py-2 rounded-md text-sm font-semibold bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {launching ? "Lanzando…" : running ? "Ejecutando…" : "Lanzar NLTHA"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Job progress */}
        {running && (
          <div className={`rounded-lg border px-3 py-2 flex flex-col gap-2 ${
            isStalled ? "border-rose-500/50 bg-rose-500/5" : "border-[var(--border)] bg-[var(--surface-2)]"
          }`}>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
                {progress.stage ?? job?.status}
              </span>
              <div className="flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
                <div className={`h-full transition-all ${isStalled ? "bg-rose-500" : "bg-[var(--accent)]"}`}
                     style={{ width: `${Math.max(2, progress.pct ?? 2)}%` }} />
              </div>
              <span className="text-xs font-mono text-[var(--text)]">
                {progress.pct !== undefined ? `${progress.pct.toFixed(0)}%` : "…"}
              </span>
              <button
                onClick={handleCancel}
                disabled={canceling}
                className="px-2.5 py-1 rounded text-[11px] font-semibold border border-rose-500/50 text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
                title="Enviar SIGKILL al proceso OpenSees"
              >
                {canceling ? "Cancelando…" : "Cancelar"}
              </button>
            </div>
            {isStalled && (
              <div className="text-xs text-rose-800 dark:text-rose-300 font-medium">
                ⚠ El progreso no avanza hace {stalledSec.toFixed(0)}s —
                {" "}es posible que un elemento sea patológico. Puedes esperar o cancelar.
              </div>
            )}
            {liveMetrics && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <ProgressStat
                  label="Transcurrido"
                  value={fmtDuration(liveMetrics.elapsedS)}
                  hint="tiempo real desde que se lanzó"
                />
                <ProgressStat
                  label="ETA"
                  value={fmtDuration(liveMetrics.etaS)}
                  hint="estimado restante basado en el progreso actual"
                  highlight
                />
                <ProgressStat
                  label="Simulado"
                  value={liveMetrics.tSim > 0 ? `${liveMetrics.tSim.toFixed(1)} s` : "—"}
                  hint="segundos del registro ya procesados"
                />
                <ProgressStat
                  label="Ratio"
                  value={liveMetrics.ratio ? `${liveMetrics.ratio.toFixed(1)}×` : "—"}
                  hint="segundos de reloj por 1 s simulado"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Historial de análisis NLTH del proyecto ─────────────────────── */}
      <NLTHHistoryList
        jobs={jobs}
        activeJobId={activeJobId}
        loadingJobId={loadingJob}
        onOpen={openHistoricalJob}
        onActivate={activateHistoricalJob}
        onDelete={deleteHistoricalJob}
        onExport={exportHistoricalJob}
        onImportClick={() => importFileInputRef.current?.click()}
      />

      {/* ── Resultados ───────────────────────────────────────────────────── */}
      {result && (
        <div className="flex flex-col gap-5">
          {/* Barra de acciones sobre el análisis actualmente visible.
              Permite guardar el análisis aún cuando no está en el historial
              (p.ej. en modo preview tras importar un JSON). */}
          <div className="flex items-center justify-between gap-3 flex-wrap bg-[var(--panel-muted)]/30 rounded-lg px-3 py-2">
            <div className="text-[11px] text-[var(--text-muted)]">
              {previewFilename ? (
                <>Mostrando archivo externo <code className="font-mono text-[var(--text)]">{previewFilename}</code></>
              ) : activeJobId ? (
                <>Mostrando análisis <code className="font-mono text-[var(--text)]">{activeJobId.slice(0, 8)}</code> del historial</>
              ) : (
                <>Mostrando el último análisis disponible</>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                const bundle = buildExportBundle(
                  result,
                  previewFilename ? "historical_job" : "live",
                  activeJobId
                    ? jobs.find((j) => j.job_id === activeJobId) ?? undefined
                    : undefined,
                );
                const activeMeta = activeJobId
                  ? jobs.find((j) => j.job_id === activeJobId)
                  : null;
                const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
                const recordLabel = activeMeta?.record_x_file
                  ?? (result as NLTHResult & { record_x_file?: string }).record_x_file
                  ?? "analysis";
                const ts = (activeMeta?.computed_at ?? new Date().toISOString())
                  .slice(0, 19).replace(/[:T]/g, "-");
                downloadBlob(bundle, `nlth_${safe(recordLabel)}_${ts}.json`);
              }}
              className="text-xs px-3 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-medium shrink-0"
              title="Descarga este análisis como JSON portable para respaldo o importación posterior."
            >
              ↓ Descargar este análisis (JSON)
            </button>
          </div>

          <VerdictHero result={result} wKN={W_kN} />

          {/* Diagnóstico de salud del solver (Ola 2) + diagnóstico elemento (Ola 7) */}
          <AnalysisHealthBanner health={result.health} projectId={projectId} />

          {/* Runtime: wall time + ratio vs simulado */}
          <RuntimeCard result={result} />

          {/* Radiografía 3D post-sismo (sin animación) */}
          {result.system === "frames" && (
            <NLTHFinalState3D projectId={projectId} result={result} demand={demand} />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PlotCard title="Desplazamiento de techo" refEl={roofRef} />
            <PlotCard title="Cortante basal Vb(t)"    refEl={vbRef} />
            <PlotCard title="Deriva por piso vs límite NSR-10"  refEl={driftRef} />
            <PlotCard
              title={(result.envelope.max_abs_accel_by_story_x_mps2 ?? result.envelope.max_abs_accel_by_story_y_mps2)
                      ? "Aceleración absoluta máxima por piso (g)"
                      : "Aceleración relativa máxima por piso (g) — relanzar NLTHA para obtener la absoluta"}
              refEl={accelRef}
            />
            <PlotCard title="Amplificación PFA / PGA por piso"         refEl={amplifRef} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,420px)] gap-4">
            <HysteresisCard refEl={hysteresisRef} />
            <OrbitCard refEl={orbitRef} />
          </div>

          <DamageSummary damage={result.damage} />

          {/* Umbrales de daño editables + eventos locales */}
          {result.system === "frames" && (
            <div className="flex flex-col gap-3">
              <DamageThresholdsPanel
                meta={thresholdsMeta}
                busy={recomputing}
                onApply={recomputeEvents}
              />
              <LocalEventsPanel
                events={result.events ?? null}
                context="nlth"
              />
            </div>
          )}

          {/* Plan de reparación por elemento (Bloque C) */}
          {result.system === "frames" && (
            <RepairPlanPanel
              events={result.events?.events ?? []}
              demand={demand}
              elementLines={result.element_lines ?? []}
            />
          )}

          {/* Tabla filtrable de rótulas críticas */}
          <CriticalHingesTable demand={demand} />

          {/* Evaluación por elemento (capacidades calculadas + D/C vs envolvente) */}
          {result.system === "frames" && (
            <details className="rounded-xl border border-[var(--border)] bg-[var(--surface)]"
                     open={false}>
              <summary className="px-4 py-3 cursor-pointer flex items-center gap-2 select-none">
                <span className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
                  Evaluación por elemento (umbrales calculados)
                </span>
                <span className="text-[10px] text-[var(--text-muted)] italic ml-auto">
                  Mander · Haselton 2008 · EC8-3 · Paulay-Priestley
                </span>
              </summary>
              <div className="px-4 pb-4 pt-1">
                <ElementThresholdsPanel projectId={projectId} />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabla filtrable de rótulas al borde / colapso (NLTHA + envolvente pushover)
// ─────────────────────────────────────────────────────────────────────────────
type HingeLevel = "none" | "near_io" | "io" | "ls" | "cp" | "collapse";

const LEVEL_COLORS: Record<HingeLevel, string> = {
  none:     "bg-slate-100 text-slate-600",
  near_io:  "bg-green-50 text-green-700",
  io:       "bg-green-100 text-green-800",
  ls:       "bg-yellow-100 text-yellow-800",
  cp:       "bg-orange-100 text-orange-800",
  collapse: "bg-red-100 text-red-800",
};

function CriticalHingesTable({ demand }: { demand: ElementDemandResult | null }) {
  const [filter, setFilter] = useState<"all" | "critical" | "collapse">("critical");
  const [kindF, setKindF]   = useState<"all" | "column" | "beam">("all");

  if (!demand || demand.source === "none" || demand.n_elements === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--text-muted)]">
        No hay demandas por elemento disponibles aún.
        Si el NLTHA se corrió antes de esta versión, relánzalo para que registre
        el daño por rótula.
      </div>
    );
  }

  const rows = Object.entries(demand.by_fid).map(([fid, d]) => ({
    fid,
    kind:         d.kind ?? "column",
    story:        d.story ?? "",
    end:          d.end_at_max,
    theta_p_max:  d.theta_p_max,
    level:        (d.level as HingeLevel) ?? "none",
    direction:    d.direction_at_max,
    source:       d.source,
    theta_CP:     d.theta_CP_fema ?? 0,
  }));

  const filtered = rows.filter(r => {
    if (kindF !== "all" && r.kind !== kindF) return false;
    if (filter === "critical" && !["ls", "cp", "collapse"].includes(r.level)) return false;
    if (filter === "collapse" && !["cp", "collapse"].includes(r.level))        return false;
    return true;
  }).sort((a, b) => b.theta_p_max - a.theta_p_max);

  const nCollapse = rows.filter(r => r.level === "collapse").length;
  const nCp       = rows.filter(r => r.level === "cp").length;
  const nLs       = rows.filter(r => r.level === "ls").length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
          Rótulas críticas por elemento
        </h4>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-slate-500">Fuente:</span>
          <span className="font-mono">{demand.source}</span>
          <span className="text-slate-500">· NLTHA:</span>
          <span className="font-mono">{demand.n_from_nlth}</span>
          <span className="text-slate-500">· Pushover:</span>
          <span className="font-mono">{demand.n_from_pushover}</span>
        </div>
      </div>

      {/* Resumen compacto */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 font-semibold">
          Colapso: {nCollapse}
        </span>
        <span className="px-2 py-0.5 rounded bg-orange-100 text-orange-800 font-semibold">
          CP: {nCp}
        </span>
        <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 font-semibold">
          LS: {nLs}
        </span>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-3 text-xs">
        <select value={filter}
                onChange={e => setFilter(e.target.value as typeof filter)}
                className="border border-slate-300 rounded px-2 py-1">
          <option value="critical">Críticas (LS/CP/Colapso)</option>
          <option value="collapse">Solo CP + Colapso</option>
          <option value="all">Todas</option>
        </select>
        <select value={kindF}
                onChange={e => setKindF(e.target.value as typeof kindF)}
                className="border border-slate-300 rounded px-2 py-1">
          <option value="all">Columnas + Vigas</option>
          <option value="column">Columnas</option>
          <option value="beam">Vigas</option>
        </select>
        <span className="text-slate-500">
          Mostrando {filtered.length} de {rows.length}
        </span>
      </div>

      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600 sticky top-0">
            <tr>
              <th className="text-left px-2 py-1">fid</th>
              <th className="text-left px-2 py-1">Tipo</th>
              <th className="text-left px-2 py-1">Piso</th>
              <th className="text-center px-2 py-1">Extremo</th>
              <th className="text-right px-2 py-1">θ_p máx (rad)</th>
              <th className="text-right px-2 py-1">θ_CP FEMA</th>
              <th className="text-right px-2 py-1">D/C</th>
              <th className="text-left px-2 py-1">Nivel</th>
              <th className="text-left px-2 py-1">Fuente</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const dcr = r.theta_CP > 0 ? r.theta_p_max / r.theta_CP : 0;
              const bg  = r.level === "collapse" ? "bg-red-50"
                        : r.level === "cp"       ? "bg-orange-50"
                        : "";
              return (
                <tr key={`${r.fid}-${r.end}`} className={`border-t border-slate-100 ${bg}`}>
                  <td className="px-2 py-1 font-mono">{r.fid}</td>
                  <td className="px-2 py-1">{r.kind === "column" ? "Col" : "Viga"}</td>
                  <td className="px-2 py-1">{r.story}</td>
                  <td className="px-2 py-1 text-center">{r.end || "—"}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {r.theta_p_max.toFixed(5)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-500">
                    {r.theta_CP ? r.theta_CP.toFixed(5) : "—"}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono font-semibold
                                  ${dcr > 1 ? "text-red-700" : dcr > 0.7 ? "text-orange-700" : ""}`}>
                    {r.theta_CP ? dcr.toFixed(2) : "—"}
                  </td>
                  <td className="px-2 py-1">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${LEVEL_COLORS[r.level]}`}>
                      {r.level}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-[10px] text-slate-500">
                    {r.source}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-slate-500">
        Las θ_CP mostradas aquí son del marco <b>FEMA/ASCE 41</b> (hardcodeadas,
        iguales para todos los elementos del mismo tipo). Para capacidades
        calculadas por elemento (con Mander, modo de falla y detallado real), ve
        a <b>Evaluación por elemento</b>.
      </p>
    </div>
  );
}

// ── Hooks de plots ───────────────────────────────────────────────────────────

function usePreviewPlot(
  ref: React.RefObject<HTMLDivElement | null>,
  preview: { t: number[]; a: number[] } | undefined,
  color: string,
) {
  useEffect(() => {
    if (!preview || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;
    Plotly.newPlot(ref.current, [{
      x: preview.t, y: preview.a, type: "scatter", mode: "lines",
      line: { color, width: 1 },
      hovertemplate: "t=%{x:.2f}s<br>a=%{y:.4g}<extra></extra>",
    }], {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 9 }, margin: { t: 4, r: 4, b: 22, l: 32 },
      xaxis: { gridcolor: "var(--border)", zeroline: false, showticklabels: true },
      yaxis: { gridcolor: "var(--border)", zeroline: true, showticklabels: true },
      showlegend: false,
    }, { responsive: true, displayModeBar: false, staticPlot: true });
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [preview, color, ref]);
}

function _argmaxAbs(arr: number[]): [number, number] {
  let idx = 0, best = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Math.abs(arr[i]);
    if (v > best) { best = v; idx = i; }
  }
  return [idx, arr[idx]];
}

function useRoofPlot(
  ref: React.RefObject<HTMLDivElement | null>,
  result: NLTHResult | null,
  events: LocalEventsPayload | null,
) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const t  = result.t_s;
    const dx = result.techo.x;
    const dy = result.techo.y;
    const [ix, dxPeak] = _argmaxAbs(dx);
    const [iy, dyPeak] = _argmaxAbs(dy);

    // Límite de deriva × altura total (NSR-10 A.6.4.2.1)
    const ductility  = (result.meta.ductility ?? "DMO").toUpperCase();
    const driftPct   = DRIFT_LIMIT_PCT[ductility] ?? 1.5;
    const H          = result.meta.total_height_m;
    const dLim       = (driftPct / 100) * H;    // m
    const dLim_mm    = dLim * 1000;

    const shapes: Record<string, unknown>[] = [
      { type: "line", xref: "paper", yref: "y",
        x0: 0, x1: 1, y0:  dLim, y1:  dLim,
        line: { color: "#dc2626", width: 1.2, dash: "dash" } },
      { type: "line", xref: "paper", yref: "y",
        x0: 0, x1: 1, y0: -dLim, y1: -dLim,
        line: { color: "#dc2626", width: 1.2, dash: "dash" } },
    ];
    const annotations: Record<string, unknown>[] = [
      { x: 1, y: dLim, xref: "paper", yref: "y",
        text: `${driftPct}% × H = ±${dLim_mm.toFixed(0)} mm (NSR-10 ${ductility})`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { color: "#dc2626", size: 9, family: "monospace" },
        bgcolor: "rgba(254,242,242,0.92)",
        bordercolor: "#dc2626", borderwidth: 1, borderpad: 2 },
      { x: t[ix], y: dxPeak, xref: "x", yref: "y",
        text: `${(dxPeak * 1000).toFixed(0)} mm`,
        showarrow: true, arrowhead: 2, arrowsize: 1, arrowwidth: 1,
        arrowcolor: "#2563eb", ax: 0, ay: dxPeak >= 0 ? -28 : 28,
        font: { size: 9, color: "#2563eb", family: "monospace" },
        bgcolor: "rgba(239,246,255,0.92)", borderpad: 2 },
      { x: t[iy], y: dyPeak, xref: "x", yref: "y",
        text: `${(dyPeak * 1000).toFixed(0)} mm`,
        showarrow: true, arrowhead: 2, arrowsize: 1, arrowwidth: 1,
        arrowcolor: "#16a34a", ax: 0, ay: dyPeak >= 0 ? -28 : 28,
        font: { size: 9, color: "#16a34a", family: "monospace" },
        bgcolor: "rgba(240,253,244,0.92)", borderpad: 2 },
    ];

    // Marcadores de eventos locales (Bloque B) — líneas verticales coloreadas
    // por tipo + traces de leyenda (sin anotaciones amontonadas en la curva).
    const extraTraces: Record<string, unknown>[] = [];
    if (events && events.status === "success" && events.events.length > 0) {
      const yMax = Math.max(Math.abs(dLim) * 1.1,
        Math.max(Math.abs(dxPeak), Math.abs(dyPeak)) * 1.1);
      const em = buildEventMarkers(events.events,
        { kind: "time" },
        { yMax, maxMarkers: 50, showAnnotations: false });  // ← SIN labels
      shapes.push(...em.shapes);
      extraTraces.push(...buildEventLegendTraces(events.events, { kind: "time" }));
    }

    Plotly.newPlot(ref.current, [
      { x: t, y: dx, type: "scatter", mode: "lines", name: "X",
        line: { color: "#2563eb", width: 2, shape: "spline", smoothing: 0.3 },
        hovertemplate: "X: %{y:.4f} m<extra></extra>" },
      { x: t, y: dy, type: "scatter", mode: "lines", name: "Y",
        line: { color: "#16a34a", width: 2, shape: "spline", smoothing: 0.3 },
        hovertemplate: "Y: %{y:.4f} m<extra></extra>" },
      { x: [t[ix]], y: [dxPeak], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#2563eb", size: 10, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate: `Pico X: %{y:.4f} m @ t=%{x:.2f}s<extra></extra>` },
      { x: [t[iy]], y: [dyPeak], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#16a34a", size: 10, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate: `Pico Y: %{y:.4f} m @ t=%{x:.2f}s<extra></extra>` },
      ...extraTraces,
    ], {
      ..._layout("t (s)", "d (m)"),
      hovermode: "x unified",
      shapes, annotations,
      showlegend: true,
      legend: {
        orientation: "h", x: 0, y: -0.22, xanchor: "left", yanchor: "top",
        font: { size: 10 }, bgcolor: "rgba(0,0,0,0)",
      },
    }, _opts());
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref, events]);
}

function useVbPlot(
  ref: React.RefObject<HTMLDivElement | null>,
  result: NLTHResult | null,
  wKN: number | null,
  events: LocalEventsPayload | null,
) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const t   = result.t_s;
    const vx  = result.Vb_history.x_kN;
    const vy  = result.Vb_history.y_kN;
    const [ix, vxPeak] = _argmaxAbs(vx);
    const [iy, vyPeak] = _argmaxAbs(vy);

    // Shapes y anotaciones: picos + referencias ×W cuando se conoce W
    type Shape      = Record<string, unknown>;
    type Annotation = Record<string, unknown>;
    const shapes:      Shape[]      = [];
    const annotations: Annotation[] = [];

    if (wKN && wKN > 0) {
      // Banda orientativa 10% – 15% W (rango típico diseño sísmico NSR-10)
      const low  = 0.10 * wKN;
      const high = 0.15 * wKN;
      shapes.push(
        { type: "rect", xref: "paper", yref: "y",
          x0: 0, x1: 1, y0:  low, y1:  high,
          fillcolor: "rgba(249,115,22,0.08)", line: { width: 0 } },
        { type: "rect", xref: "paper", yref: "y",
          x0: 0, x1: 1, y0: -high, y1: -low,
          fillcolor: "rgba(249,115,22,0.08)", line: { width: 0 } },
        { type: "line", xref: "paper", yref: "y",
          x0: 0, x1: 1, y0:  high, y1:  high,
          line: { color: "#f97316", width: 1, dash: "dot" } },
        { type: "line", xref: "paper", yref: "y",
          x0: 0, x1: 1, y0: -high, y1: -high,
          line: { color: "#f97316", width: 1, dash: "dot" } },
      );
      annotations.push({
        x: 1, y: high, xref: "paper", yref: "y",
        text: `Banda ≈ 0.10–0.15 W (W = ${wKN.toFixed(0)} kN)`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { color: "#c2410c", size: 9, family: "monospace" },
        bgcolor: "rgba(255,247,237,0.92)",
        bordercolor: "#f97316", borderwidth: 1, borderpad: 2,
      });
    }

    annotations.push(
      { x: t[ix], y: vxPeak, xref: "x", yref: "y",
        text: `${vxPeak.toFixed(0)} kN` +
              (wKN ? ` · ${(vxPeak / wKN * 100).toFixed(1)}% W` : ""),
        showarrow: true, arrowhead: 2, arrowsize: 1, arrowwidth: 1,
        arrowcolor: "#2563eb", ax: 0, ay: vxPeak >= 0 ? -28 : 28,
        font: { size: 9, color: "#2563eb", family: "monospace" },
        bgcolor: "rgba(239,246,255,0.92)", borderpad: 2 },
      { x: t[iy], y: vyPeak, xref: "x", yref: "y",
        text: `${vyPeak.toFixed(0)} kN` +
              (wKN ? ` · ${(vyPeak / wKN * 100).toFixed(1)}% W` : ""),
        showarrow: true, arrowhead: 2, arrowsize: 1, arrowwidth: 1,
        arrowcolor: "#16a34a", ax: 0, ay: vyPeak >= 0 ? -28 : 28,
        font: { size: 9, color: "#16a34a", family: "monospace" },
        bgcolor: "rgba(240,253,244,0.92)", borderpad: 2 },
    );

    // Marcadores de eventos locales — líneas verticales + leyenda compartida.
    const extraTraces: Record<string, unknown>[] = [];
    if (events && events.status === "success" && events.events.length > 0) {
      const yMax = Math.max(Math.abs(vxPeak), Math.abs(vyPeak)) * 1.1;
      const em = buildEventMarkers(events.events,
        { kind: "time" },
        { yMax, maxMarkers: 50, showAnnotations: false });
      shapes.push(...em.shapes);
      extraTraces.push(...buildEventLegendTraces(events.events, { kind: "time" }));
    }

    Plotly.newPlot(ref.current, [
      { x: t, y: vx, type: "scatter", mode: "lines", name: "Vb X",
        line: { color: "#2563eb", width: 2, shape: "spline", smoothing: 0.3 },
        hovertemplate: "Vb X: %{y:.0f} kN<extra></extra>" },
      { x: t, y: vy, type: "scatter", mode: "lines", name: "Vb Y",
        line: { color: "#16a34a", width: 2, shape: "spline", smoothing: 0.3 },
        hovertemplate: "Vb Y: %{y:.0f} kN<extra></extra>" },
      { x: [t[ix]], y: [vxPeak], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#2563eb", size: 10, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate: `Pico X: %{y:.0f} kN @ t=%{x:.2f}s<extra></extra>` },
      { x: [t[iy]], y: [vyPeak], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#16a34a", size: 10, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate: `Pico Y: %{y:.0f} kN @ t=%{x:.2f}s<extra></extra>` },
      ...extraTraces,
    ], {
      ..._layout("t (s)", "Vb (kN)"),
      hovermode: "x unified",
      shapes,
      annotations,
      showlegend: true,
      legend: {
        orientation: "h", x: 0, y: -0.22, xanchor: "left", yanchor: "top",
        font: { size: 10 }, bgcolor: "rgba(0,0,0,0)",
      },
    }, _opts());
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref, wKN, events]);
}

function useDriftPlot(ref: React.RefObject<HTMLDivElement | null>, result: NLTHResult | null) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;
    const dx = result.envelope.max_drift_by_story_x;
    const dy = result.envelope.max_drift_by_story_y;
    // Altura aproximada por piso (constante): H_total / n_pisos.
    const dzApprox = result.meta.total_height_m / Math.max(dx.length, 1);
    const stories = dx.map((_, i) =>
      `N${i + 1} (${((i + 1) * dzApprox).toFixed(1)} m)`
    );
    const ductility = (result.meta.ductility ?? "DMO").toUpperCase();
    const limit = DRIFT_LIMIT_PCT[ductility] ?? 1.5;
    // Colorear rojo las barras que exceden el límite
    const colorX = dx.map((v) => v > limit ? "#dc2626" : "#2563eb");
    const colorY = dy.map((v) => v > limit ? "#dc2626" : "#16a34a");
    const xMax = Math.max(limit * 1.3, Math.max(...dx, ...dy) * 1.15);

    Plotly.newPlot(ref.current, [
      { x: dx, y: stories, type: "bar", orientation: "h", name: "X",
        marker: { color: colorX, line: { color: "#1e40af", width: 0.5 } },
        hovertemplate: "%{y} · X: %{x:.3f}%<extra></extra>" },
      { x: dy, y: stories, type: "bar", orientation: "h", name: "Y",
        marker: { color: colorY, line: { color: "#15803d", width: 0.5 } },
        hovertemplate: "%{y} · Y: %{x:.3f}%<extra></extra>" },
    ], {
      ..._layout("Deriva de entrepiso (%)", ""),
      barmode: "group",
      // Convención física: Piso 1 abajo, cubierta arriba (default de categorías).
      yaxis: { categoryorder: "array", categoryarray: stories },
      xaxis: { title: { text: "Deriva de entrepiso (%)" }, gridcolor: "var(--border)",
               range: [0, xMax], zeroline: true, zerolinecolor: "var(--border)" },
      shapes: [{
        type: "line", xref: "x", yref: "paper",
        x0: limit, x1: limit, y0: 0, y1: 1,
        line: { color: "#dc2626", width: 2, dash: "dash" },
      }],
      annotations: [{
        x: limit, y: 1.03, xref: "x", yref: "paper",
        text: `Límite ${limit}% · NSR-10 ${ductility}`,
        showarrow: false, xanchor: "left", yanchor: "bottom",
        font: { color: "#dc2626", size: 10, family: "monospace" },
        bgcolor: "#fef2f2", bordercolor: "#dc2626", borderwidth: 1, borderpad: 3,
      }],
    }, _opts());
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref]);
}

function useAccelPlot(ref: React.RefObject<HTMLDivElement | null>, result: NLTHResult | null) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;
    const G = 9.80665;
    const env = result.envelope;
    // Prefiere la aceleración absoluta (= ü_rel + ü_g). Si viene de un run
    // viejo sin ese campo, usa el alias legacy max_accel_* (que ya reportamos
    // de forma incorrecta como "absoluta" pero era en realidad relativa).
    const absX = env.max_abs_accel_by_story_x_mps2 ?? env.max_accel_by_story_x_mps2 ?? [];
    const absY = env.max_abs_accel_by_story_y_mps2 ?? env.max_accel_by_story_y_mps2 ?? [];
    const ax = absX.map((v) => v / G);
    const ay = absY.map((v) => v / G);
    const pgaXg = env.pga_x_g ?? ((env.pga_x_mps2 ?? 0) / G);
    const pgaYg = env.pga_y_g ?? ((env.pga_y_mps2 ?? 0) / G);
    const pgaMax = Math.max(pgaXg, pgaYg);

    const dzApprox = result.meta.total_height_m / Math.max(ax.length, 1);
    const stories = ax.map((_, i) =>
      `N${i + 1} (${((i + 1) * dzApprox).toFixed(1)} m)`
    );

    const shapes: Record<string, unknown>[] = [];
    const annotations: Record<string, unknown>[] = [];
    if (pgaMax > 0) {
      shapes.push({
        type: "line", xref: "x", yref: "paper",
        x0: pgaMax, x1: pgaMax, y0: 0, y1: 1,
        line: { color: "#dc2626", width: 1.5, dash: "dash" },
      });
      annotations.push({
        x: pgaMax, y: 1.03, xref: "x", yref: "paper",
        text: `PGA = ${pgaMax.toFixed(3)} g`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { color: "#dc2626", size: 10, family: "monospace" },
        bgcolor: "#fef2f2", bordercolor: "#dc2626", borderwidth: 1, borderpad: 3,
      });
    }

    Plotly.newPlot(ref.current, [
      { x: ax, y: stories, type: "bar", orientation: "h", name: "X",
        marker: { color: "#2563eb", line: { color: "#1e40af", width: 0.5 } },
        hovertemplate: `%{y} · X: %{x:.3f} g (PGAx = ${pgaXg.toFixed(3)} g)<extra></extra>` },
      { x: ay, y: stories, type: "bar", orientation: "h", name: "Y",
        marker: { color: "#16a34a", line: { color: "#15803d", width: 0.5 } },
        hovertemplate: `%{y} · Y: %{x:.3f} g (PGAy = ${pgaYg.toFixed(3)} g)<extra></extra>` },
    ], {
      ..._layout("Aceleración absoluta de piso (g)", ""),
      barmode: "group",
      yaxis: { categoryorder: "array", categoryarray: stories },
      shapes, annotations,
    }, _opts());
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref]);
}

function useAmplificationPlot(ref: React.RefObject<HTMLDivElement | null>, result: NLTHResult | null) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const G   = 9.80665;
    const env = result.envelope;
    // Si el backend no devolvió amplificaciones (run viejo), las calculamos
    // on-the-fly con la absoluta y el PGA, cuando ambos estén disponibles.
    const pgaX = env.pga_x_mps2 ?? 0;
    const pgaY = env.pga_y_mps2 ?? 0;
    const absX = env.max_abs_accel_by_story_x_mps2 ?? env.max_accel_by_story_x_mps2 ?? [];
    const absY = env.max_abs_accel_by_story_y_mps2 ?? env.max_accel_by_story_y_mps2 ?? [];
    const ampX = env.accel_amplification_by_story_x ?? (pgaX > 0 ? absX.map((v) => v / pgaX) : []);
    const ampY = env.accel_amplification_by_story_y ?? (pgaY > 0 ? absY.map((v) => v / pgaY) : []);

    if (ampX.length === 0 && ampY.length === 0) {
      Plotly.newPlot(ref.current, [], {
        ..._layout("PFA / PGA (adim.)", ""),
        annotations: [{
          x: 0.5, y: 0.5, xref: "paper", yref: "paper",
          text: "Sin PGA disponible — relanza el NLTHA con el motor nuevo",
          showarrow: false,
          font: { color: "#6b7280", size: 11 },
        }],
      }, _opts());
      return () => { if (ref.current) Plotly.purge(ref.current); };
    }

    const n = Math.max(ampX.length, ampY.length);
    const dzApprox = result.meta.total_height_m / Math.max(n, 1);
    const stories = Array.from({ length: n }, (_, i) =>
      `N${i + 1} (${((i + 1) * dzApprox).toFixed(1)} m)`
    );

    const pgaXg = pgaX / G;
    const pgaYg = pgaY / G;

    Plotly.newPlot(ref.current, [
      { x: ampX, y: stories, type: "bar", orientation: "h", name: "X",
        marker: { color: "#2563eb", line: { color: "#1e40af", width: 0.5 } },
        hovertemplate: `%{y} · PFAx/PGAx: %{x:.2f} (PGAx = ${pgaXg.toFixed(3)} g)<extra></extra>` },
      { x: ampY, y: stories, type: "bar", orientation: "h", name: "Y",
        marker: { color: "#16a34a", line: { color: "#15803d", width: 0.5 } },
        hovertemplate: `%{y} · PFAy/PGAy: %{x:.2f} (PGAy = ${pgaYg.toFixed(3)} g)<extra></extra>` },
    ], {
      ..._layout("PFA / PGA (adim.)", ""),
      barmode: "group",
      yaxis: { categoryorder: "array", categoryarray: stories },
      shapes: [{
        type: "line", xref: "x", yref: "paper",
        x0: 1, x1: 1, y0: 0, y1: 1,
        line: { color: "#64748b", width: 1.5, dash: "dash" },
      }],
      annotations: [{
        x: 1, y: 1.03, xref: "x", yref: "paper",
        text: "PFA = PGA (sin amplificación)",
        showarrow: false, xanchor: "left", yanchor: "bottom",
        font: { color: "#475569", size: 10, family: "monospace" },
        bgcolor: "#f1f5f9", bordercolor: "#64748b", borderwidth: 1, borderpad: 3,
      }],
    }, _opts());
    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref]);
}

/** Energía absorbida acumulada ≈ ∫ Vb·dδ (kN·m). Para respuesta puramente
 *  elástica retorna a 0; para respuesta histerética queda > 0 al final y
 *  es una aproximación de la energía disipada por histéresis + damping. */
function _absorbedEnergy_kNm(dMm: number[], VbKN: number[]): number {
  let E = 0;
  for (let i = 1; i < dMm.length; i++) {
    const dDm = (dMm[i] - dMm[i - 1]) / 1000;
    E += ((VbKN[i] + VbKN[i - 1]) / 2) * dDm;
  }
  return Math.abs(E);
}

function useHysteresisPlot(
  ref: React.RefObject<HTMLDivElement | null>,
  result: NLTHResult | null,
) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const t    = result.t_s;
    const dxMm = result.techo.x.map((v) => v * 1000);
    const dyMm = result.techo.y.map((v) => v * 1000);
    const vx   = result.Vb_history.x_kN;
    const vy   = result.Vb_history.y_kN;
    const nX = dxMm.length, nY = dyMm.length;

    const [ixVb, vxPk] = _argmaxAbs(vx);
    const [iyVb, vyPk] = _argmaxAbs(vy);
    const dxEnd = dxMm[nX - 1];
    const dyEnd = dyMm[nY - 1];
    const vxEnd = vx[nX - 1];
    const vyEnd = vy[nY - 1];

    const Ex = _absorbedEnergy_kNm(dxMm, vx);
    const Ey = _absorbedEnergy_kNm(dyMm, vy);

    Plotly.newPlot(ref.current, [
      // Curva X
      { x: dxMm, y: vx, type: "scatter", mode: "lines", name: "X",
        line: { color: "#2563eb", width: 1 },
        xaxis: "x", yaxis: "y",
        customdata: t,
        hovertemplate:
          "δ: %{x:.1f} mm<br>Vb: %{y:.0f} kN<br>t: %{customdata:.2f}s<extra>X</extra>" },
      // Curva Y
      { x: dyMm, y: vy, type: "scatter", mode: "lines", name: "Y",
        line: { color: "#16a34a", width: 1 },
        xaxis: "x2", yaxis: "y2",
        customdata: t,
        hovertemplate:
          "δ: %{x:.1f} mm<br>Vb: %{y:.0f} kN<br>t: %{customdata:.2f}s<extra>Y</extra>" },
      // Pico de Vb — X
      { x: [dxMm[ixVb]], y: [vxPk], type: "scatter", mode: "markers",
        xaxis: "x", yaxis: "y", showlegend: false,
        marker: { color: "#2563eb", size: 11, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate:
          `Pico X · Vb=%{y:.0f} kN<br>δ=%{x:.1f} mm @ t=${t[ixVb].toFixed(2)}s<extra></extra>` },
      // Pico de Vb — Y
      { x: [dyMm[iyVb]], y: [vyPk], type: "scatter", mode: "markers",
        xaxis: "x2", yaxis: "y2", showlegend: false,
        marker: { color: "#16a34a", size: 11, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate:
          `Pico Y · Vb=%{y:.0f} kN<br>δ=%{x:.1f} mm @ t=${t[iyVb].toFixed(2)}s<extra></extra>` },
      // Residual X
      { x: [dxEnd], y: [vxEnd], type: "scatter", mode: "markers",
        xaxis: "x", yaxis: "y", showlegend: false,
        marker: { color: "#dc2626", size: 11, symbol: "x",
                  line: { color: "#dc2626", width: 3 } },
        hovertemplate: `Residual X · δ=%{x:.1f} mm · Vb=%{y:.0f} kN<extra></extra>` },
      // Residual Y
      { x: [dyEnd], y: [vyEnd], type: "scatter", mode: "markers",
        xaxis: "x2", yaxis: "y2", showlegend: false,
        marker: { color: "#dc2626", size: 11, symbol: "x",
                  line: { color: "#dc2626", width: 3 } },
        hovertemplate: `Residual Y · δ=%{x:.1f} mm · Vb=%{y:.0f} kN<extra></extra>` },
    ], {
      grid: { rows: 1, columns: 2, pattern: "independent" },
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 11 }, margin: { t: 36, r: 10, b: 44, l: 60 },
      xaxis:  { title: { text: "δ_techo (mm)" }, gridcolor: "var(--border)",
                zeroline: true, zerolinecolor: "#94a3b8", zerolinewidth: 1 },
      yaxis:  { title: { text: "Vb (kN)" }, gridcolor: "var(--border)",
                zeroline: true, zerolinecolor: "#94a3b8", zerolinewidth: 1 },
      xaxis2: { title: { text: "δ_techo (mm)" }, gridcolor: "var(--border)",
                zeroline: true, zerolinecolor: "#94a3b8", zerolinewidth: 1 },
      yaxis2: { title: { text: "Vb (kN)" }, gridcolor: "var(--border)",
                zeroline: true, zerolinecolor: "#94a3b8", zerolinewidth: 1 },
      showlegend: false,
      annotations: [
        { x: 0.22, y: 1.05, xref: "paper", yref: "paper",
          text: `<b>Dirección X</b> · E ≈ ${Ex.toFixed(1)} kN·m · δ_res = ${dxEnd.toFixed(1)} mm`,
          showarrow: false, xanchor: "center",
          font: { color: "#2563eb", size: 10, family: "monospace" } },
        { x: 0.78, y: 1.05, xref: "paper", yref: "paper",
          text: `<b>Dirección Y</b> · E ≈ ${Ey.toFixed(1)} kN·m · δ_res = ${dyEnd.toFixed(1)} mm`,
          showarrow: false, xanchor: "center",
          font: { color: "#16a34a", size: 10, family: "monospace" } },
      ],
    }, { responsive: true, displayModeBar: false });

    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref]);
}

function useOrbitPlot(
  ref: React.RefObject<HTMLDivElement | null>,
  result: NLTHResult | null,
) {
  useEffect(() => {
    if (!result || !ref.current) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void; purge: (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const t    = result.t_s;
    const dxMm = result.techo.x.map((v) => v * 1000);
    const dyMm = result.techo.y.map((v) => v * 1000);
    const n    = Math.min(dxMm.length, dyMm.length);

    // Pico vectorial √(dx² + dy²)
    let iPk = 0, rPk = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(dxMm[i], dyMm[i]);
      if (r > rPk) { rPk = r; iPk = i; }
    }
    const dxEnd = dxMm[n - 1], dyEnd = dyMm[n - 1];
    const rEnd  = Math.hypot(dxEnd, dyEnd);

    // Círculo de aceptación: deriva límite × H (NSR-10 A.6.4.2.1)
    const ductility = (result.meta.ductility ?? "DMO").toUpperCase();
    const driftPct  = DRIFT_LIMIT_PCT[ductility] ?? 1.5;
    const H         = result.meta.total_height_m;
    const rLim      = (driftPct / 100) * H * 1000;     // mm

    // Rango con margen para que entre el círculo límite y los extremos
    const maxVal = Math.max(rPk, rLim) * 1.2;

    Plotly.newPlot(ref.current, [
      // Trayectoria
      { x: dxMm, y: dyMm, type: "scatter", mode: "lines", name: "Órbita",
        line: { color: "#64748b", width: 1 },
        customdata: t,
        hovertemplate:
          "δx: %{x:.1f} mm<br>δy: %{y:.1f} mm<br>t: %{customdata:.2f}s<extra></extra>" },
      // Pico vectorial
      { x: [dxMm[iPk]], y: [dyMm[iPk]], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#f59e0b", size: 12, symbol: "circle",
                  line: { color: "white", width: 2 } },
        hovertemplate:
          `Pico vectorial · r=${rPk.toFixed(1)} mm @ t=${t[iPk].toFixed(2)}s<extra></extra>` },
      // Residual
      { x: [dxEnd], y: [dyEnd], type: "scatter", mode: "markers",
        showlegend: false,
        marker: { color: "#dc2626", size: 12, symbol: "x",
                  line: { color: "#dc2626", width: 3 } },
        hovertemplate: `Residual · δ=(%{x:.1f}, %{y:.1f}) mm<extra></extra>` },
    ], {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 11 }, margin: { t: 36, r: 10, b: 44, l: 60 },
      xaxis: { title: { text: "δ_techo X (mm)" }, gridcolor: "var(--border)",
               zeroline: true, zerolinecolor: "#94a3b8",
               range: [-maxVal, maxVal] },
      yaxis: { title: { text: "δ_techo Y (mm)" }, gridcolor: "var(--border)",
               zeroline: true, zerolinecolor: "#94a3b8",
               range: [-maxVal, maxVal],
               scaleanchor: "x", scaleratio: 1 },
      showlegend: false,
      shapes: [
        // Círculo límite NSR-10
        { type: "circle", xref: "x", yref: "y",
          x0: -rLim, x1: rLim, y0: -rLim, y1: rLim,
          line: { color: "#dc2626", width: 1.5, dash: "dash" } },
      ],
      annotations: [
        { x: 0.5, y: 1.05, xref: "paper", yref: "paper",
          text: `<b>Órbita del techo</b> · pico vectorial = ${rPk.toFixed(1)} mm · residual = ${rEnd.toFixed(1)} mm`,
          showarrow: false, xanchor: "center",
          font: { color: "var(--text)", size: 10, family: "monospace" } },
        { x: 0, y: rLim, xref: "x", yref: "y",
          text: `Límite ${driftPct}% × H`,
          showarrow: false, xanchor: "center", yanchor: "bottom",
          font: { color: "#dc2626", size: 9, family: "monospace" },
          bgcolor: "rgba(254,242,242,0.9)",
          bordercolor: "#dc2626", borderwidth: 1, borderpad: 2 },
      ],
    }, { responsive: true, displayModeBar: false });

    return () => { if (ref.current) Plotly.purge(ref.current); };
  }, [result, ref]);
}

// Layout premium reusado por todos los gráficos del panel NLTH (Ola 4 2026-11-04).
// Delegamos a plotlyLayoutPremium para el look&feel central (títulos en negrilla,
// grilla sutil, hover elegante, zero line marcada). Añadimos una leyenda top-right
// semi-transparente — útil cuando los charts tienen varias trazas por piso.
function _layout(xLabel: string, yLabel: string) {
  return {
    ...plotlyLayoutPremium({ xTitle: xLabel, yTitle: yLabel, showLegend: true, legendTop: true }),
    legend: {
      x: 1, y: 1.08, xanchor: "right", yanchor: "bottom",
      orientation: "h" as const,
      font: { family: "Inter, system-ui, sans-serif", size: 10, color: "var(--text)" },
      bgcolor: "rgba(0,0,0,0)",
    },
  };
}

function _opts() {
  return { ...plotlyConfigPremium, displayModeBar: false };
}

// ── Sub-componentes ─────────────────────────────────────────────────────────

function RecordUpload({
  dir, upload, uploading, onFile, previewRef,
}: {
  dir:        "X" | "Y";
  upload:     NLTHUploadResult | null;
  uploading:  boolean;
  onFile:     (f: File | null) => void;
  previewRef: React.RefObject<HTMLDivElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasFile  = !!upload?.path;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 flex flex-col gap-2">
      {/* Zona de drop/click */}
      <div
        className="rounded-md border-2 border-dashed border-[var(--border)] bg-[var(--surface)] px-3 py-2 flex items-center gap-3 cursor-pointer hover:border-[var(--accent)] transition-colors"
        onClick={() => inputRef.current?.click()}
      >
        <div className="rounded-full w-9 h-9 bg-[var(--accent)] text-white flex items-center justify-center font-bold">{dir}</div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-[var(--text)]">
            Registro {dir} {uploading && <span className="text-[var(--text-muted)]">— subiendo…</span>}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] truncate">
            {upload?.filename ?? "Click: PEER .at2 / FEMA .txt / CSV"}
          </p>
        </div>
        <input ref={inputRef} type="file" className="hidden"
          accept=".acc,.at2,.AT2,.txt,.dat,.csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {hasFile && upload && (
        <>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-muted)] font-mono px-1">
            <span>Formato:</span>  <span className="text-[var(--text)]">{upload.format}</span>
            <span>Muestras:</span> <span className="text-[var(--text)]">{upload.n_samples}</span>
            <span>dt:</span>       <span className={upload.dt_detected ? "text-green-600" : "text-amber-600"}>
              {upload.dt_detected ? `${upload.dt_detected.toFixed(5)} s` : "no detectado"}
            </span>
            <span>Duración:</span> <span className="text-[var(--text)]">
              {upload.duration_s ? `${upload.duration_s.toFixed(2)} s` : "—"}
            </span>
            <span>PGA:</span>      <span className="text-[var(--text)]">{upload.pga.toExponential(3)}</span>
            <span>Unidades:</span> <span className={upload.units_hint ? "text-green-600" : "text-amber-600"}>
              {upload.units_hint ?? "no detectadas"}
            </span>
          </div>
          <div ref={previewRef} style={{ height: 90 }}
               className="rounded border border-[var(--border)] bg-[var(--surface)]" />
        </>
      )}
    </div>
  );
}

// ── Verdict de desempeño ────────────────────────────────────────────────────

// Límite de deriva de entrepiso por ductilidad (NSR-10 A.6.4.2.1)
const DRIFT_LIMIT_PCT: Record<string, number> = {
  DES: 2.5, DMO: 1.5, DMI: 1.0,
};

type VerdictLevel = "SIN_DAÑO" | "IO" | "LS" | "CP" | "COLAPSO";

interface Verdict {
  level:         VerdictLevel;
  label:         string;
  color:         string;
  description:   string;
  drift_max:     number;
  drift_limit:   number;
  drift_ok:      boolean;
  ductility:     string;
  Vb_W_ratio:    number | null;
  n_crit_total:  number;    // CP + Colapso (frames) o severo + colapso (walls)
  duration_ok:   boolean;
  // ── Justificación del veredicto ────────────────────────────────────────
  reasons:       string[];           // bullets humanamente legibles
  gov_dir:       "X" | "Y" | null;   // dirección que gobierna la deriva
  gov_story_idx: number | null;      // índice (1-based) del piso crítico
  damage_counts: Record<string, number>;
}

function computeVerdict(result: NLTHResult, totalWeightKN: number | null): Verdict {
  const ductility   = (result.meta.ductility ?? "DMO").toUpperCase();
  const drift_limit = DRIFT_LIMIT_PCT[ductility] ?? 1.5;
  const drift_max   = result.envelope.max_drift_pct;
  const drift_ok    = drift_max <= drift_limit;

  const Vb = Math.max(result.envelope.max_Vb_x_kN, result.envelope.max_Vb_y_kN);
  const Vb_W_ratio = totalWeightKN && totalWeightKN > 0 ? Vb / totalWeightKN : null;

  const duration_ok = result.envelope.t_elapsed_s + 1e-3 >= result.envelope.t_target_s;

  // Dirección y piso que gobierna la deriva
  const dx = result.envelope.max_drift_by_story_x ?? [];
  const dy = result.envelope.max_drift_by_story_y ?? [];
  const maxX = dx.length ? Math.max(...dx) : 0;
  const maxY = dy.length ? Math.max(...dy) : 0;
  const gov_dir: "X" | "Y" | null =
    maxX === 0 && maxY === 0 ? null : (maxX >= maxY ? "X" : "Y");
  const gov_series = gov_dir === "X" ? dx : (gov_dir === "Y" ? dy : []);
  const gov_story_idx = gov_series.length
    ? gov_series.indexOf(Math.max(...gov_series)) + 1
    : null;

  // Conteos de daño (frames: io/ls/cp/collapse, walls: minor/moderate/severe/collapse)
  const dmgCounts: Record<string, number> =
    result.damage.status === "success"
      ? (result.damage.counts as Record<string, number>)
      : {};

  // Nivel global = peor de todos los elementos
  let level: VerdictLevel = "SIN_DAÑO";
  let n_crit = 0;
  if (result.damage.status === "success") {
    const c = dmgCounts;
    if ((c.collapse ?? 0) > 0)              { level = "COLAPSO"; }
    else if ((c.cp ?? c.severe ?? 0) > 0)   { level = "CP"; }
    else if ((c.ls ?? c.moderate ?? 0) > 0) { level = "LS"; }
    else if ((c.io ?? c.minor ?? 0) > 0)    { level = "IO"; }
    n_crit = (c.collapse ?? 0) + (c.cp ?? c.severe ?? 0);
  }
  // Si cruza el límite de deriva, al menos LS
  if (!drift_ok && (level === "SIN_DAÑO" || level === "IO")) level = "LS";

  // ── Justificación: 2-4 bullets concretos ─────────────────────────────────
  const reasons: string[] = [];
  if (gov_dir && gov_story_idx) {
    const gov_val = gov_dir === "X" ? maxX : maxY;
    const comp = drift_ok ? "≤ límite" : `> límite ${drift_limit}%`;
    reasons.push(
      `Deriva máx ${gov_val.toFixed(3)}% en dirección ${gov_dir}, ` +
      `piso N${gov_story_idx} (${comp} NSR-10 ${ductility}).`
    );
  }
  if (result.damage.status === "success") {
    const isHinges = "max_theta_p" in result.damage;
    if (isHinges) {
      const nColl = dmgCounts.collapse ?? 0;
      const nCp   = dmgCounts.cp ?? 0;
      const nLs   = dmgCounts.ls ?? 0;
      const nIo   = dmgCounts.io ?? 0;
      if (nColl + nCp + nLs + nIo === 0) {
        reasons.push("No se detectaron rótulas plásticas que crucen umbrales ASCE 41.");
      } else {
        const parts: string[] = [];
        if (nColl > 0) parts.push(`${nColl} en colapso`);
        if (nCp   > 0) parts.push(`${nCp} en CP`);
        if (nLs   > 0) parts.push(`${nLs} en LS`);
        if (nIo   > 0) parts.push(`${nIo} en IO`);
        reasons.push(`Rótulas plásticas: ${parts.join(", ")}.`);
      }
    } else {
      // walls: Park-Ang por piso
      const nColl = dmgCounts.collapse ?? 0;
      const nSev  = dmgCounts.severe ?? 0;
      const nMod  = dmgCounts.moderate ?? 0;
      if (nColl + nSev + nMod === 0) {
        reasons.push("Ningún piso excede DI=0.25 (daño moderado).");
      } else {
        const parts: string[] = [];
        if (nColl > 0) parts.push(`${nColl} piso(s) en colapso`);
        if (nSev  > 0) parts.push(`${nSev} severo`);
        if (nMod  > 0) parts.push(`${nMod} moderado`);
        reasons.push(`Daño por piso (Park-Ang): ${parts.join(", ")}.`);
      }
    }
  } else {
    reasons.push("Daño por elemento: no disponible (relanzar NLTHA para capturar θ_p por rótula).");
  }
  if (Vb_W_ratio !== null) {
    reasons.push(
      `Cortante basal máx = ${(Vb_W_ratio * 100).toFixed(1)}% del peso W del edificio.`
    );
  }
  if (!duration_ok) {
    reasons.push(
      `Análisis incompleto: t=${result.envelope.t_elapsed_s.toFixed(1)}s de ` +
      `${result.envelope.t_target_s.toFixed(1)}s objetivo (perdió convergencia).`
    );
  }
  // Conteo físico de eventos locales (Bloque C): elementos únicos por tipo
  if (result.events && result.events.status === "success") {
    const uniqByType: Record<string, Set<string>> = {};
    for (const ev of result.events.events) {
      (uniqByType[ev.type] = uniqByType[ev.type] ?? new Set()).add(ev.fid);
    }
    const nFrac = uniqByType.bar_fracture?.size ?? 0;
    const nBuck = uniqByType.bar_buckling?.size ?? 0;
    const nCore = uniqByType.core_crush?.size ?? 0;
    const nCov  = uniqByType.cover_crush?.size ?? 0;
    const parts: string[] = [];
    if (nFrac > 0) parts.push(`${nFrac} con fractura de refuerzo`);
    if (nBuck > 0) parts.push(`${nBuck} con pandeo`);
    if (nCore > 0) parts.push(`${nCore} con aplastamiento del núcleo`);
    if (nCov  > 0 && !nCore) parts.push(`${nCov} con spalling de recubrimiento`);
    if (parts.length > 0) {
      reasons.push(`Daño físico detectado: ${parts.join(", ")}.`);
    }
  }

  const LABEL: Record<VerdictLevel, string> = {
    SIN_DAÑO: "Sin daño",
    IO:       "Operativo (IO)",
    LS:       "Seguridad de vida (LS)",
    CP:       "Prevención de colapso (CP)",
    COLAPSO:  "Colapso",
  };
  const COLOR: Record<VerdictLevel, string> = {
    SIN_DAÑO: "#10b981",
    IO:       "#22c55e",
    LS:       "#eab308",
    CP:       "#f97316",
    COLAPSO:  "#ef4444",
  };
  const DESC: Record<VerdictLevel, string> = {
    SIN_DAÑO: "El edificio responde elásticamente al registro.",
    IO:       "Daño mínimo: el edificio permanece operativo tras el sismo.",
    LS:       "Daño moderado: seguridad de vida garantizada. Reparación posible sin desocupar.",
    CP:       "Daño severo: cerca del colapso. Requiere evaluación detallada y reforzamiento.",
    COLAPSO:  "Mecanismo de colapso formado. El edificio no cumple con el nivel de desempeño mínimo.",
  };

  return {
    level, label: LABEL[level], color: COLOR[level], description: DESC[level],
    drift_max, drift_limit, drift_ok, ductility,
    Vb_W_ratio, n_crit_total: n_crit, duration_ok,
    reasons, gov_dir, gov_story_idx, damage_counts: dmgCounts,
  };
}

function RuntimeCard({ result }: { result: NLTHResult }) {
  const rt = result.runtime;
  if (!rt) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-[11px] text-[var(--text-muted)] flex items-center gap-2">
        <span className="opacity-60">⏱</span>
        <span>Tiempo de corrida no registrado (resultado previo a Oct 22).</span>
      </div>
    );
  }
  const wallMin   = rt.wall_time_min;
  const simSec    = rt.t_simulated_s;
  const ratio     = rt.speed_ratio;
  // Formato legible
  const wallFmt = wallMin < 1
    ? `${rt.wall_time_s.toFixed(0)} s`
    : wallMin < 60
    ? `${wallMin.toFixed(1)} min`
    : `${(wallMin / 60).toFixed(1)} h`;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 flex items-center gap-5 flex-wrap">
      <div className="flex items-center gap-2">
        <span className="text-base">⏱</span>
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Tiempo de corrida
        </span>
      </div>
      <RuntimeStat label="Reloj (wall)" value={wallFmt}
                   detail="duración total del análisis" />
      <RuntimeStat label="Simulado" value={`${simSec.toFixed(1)} s`}
                   detail="segundos del registro procesados" />
      <RuntimeStat label="Factor" value={`${ratio.toFixed(1)}×`}
                   detail={`${ratio.toFixed(1)} s reloj por 1 s simulado`} />
      <p className="text-[10px] text-[var(--text-muted)] italic ml-auto">
        Útil para estimar próximas corridas: duración ≈ (dt_registro × N_pts) × {ratio.toFixed(1)}
      </p>
    </div>
  );
}

function RuntimeStat({ label, value, detail }: {
  label: string; value: string; detail: string;
}) {
  return (
    <div className="flex flex-col leading-tight" title={detail}>
      <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">
        {label}
      </span>
      <span className="text-sm font-mono font-semibold text-[var(--text)]">
        {value}
      </span>
    </div>
  );
}

function ProgressStat({ label, value, hint, highlight = false }: {
  label: string; value: string; hint: string; highlight?: boolean;
}) {
  return (
    <div
      title={hint}
      className={`flex items-baseline justify-between gap-1 rounded border px-2 py-1 ${
        highlight
          ? "border-amber-300 bg-amber-50"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      <span className={`text-[9px] uppercase tracking-wider ${
        highlight ? "text-amber-700" : "text-[var(--text-muted)]"
      }`}>
        {label}
      </span>
      <span className={`font-mono font-semibold ${
        highlight ? "text-amber-900" : "text-[var(--text)]"
      }`}>
        {value}
      </span>
    </div>
  );
}

function VerdictHero({ result, wKN }: { result: NLTHResult; wKN: number | null }) {
  const v = computeVerdict(result, wKN);

  const total_hinges = result.damage.status === "success"
    ? Object.values(result.damage.counts as Record<string, number>).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="rounded-xl border-2 overflow-hidden"
         style={{ borderColor: v.color, background: `${v.color}0A` }}>
      {/* Row principal con verdict + KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,320px)_1fr] gap-0">
        {/* Verdict */}
        <div className="px-5 py-4 flex flex-col gap-2 border-r border-[var(--border)]"
             style={{ background: `${v.color}18` }}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: v.color }} />
            <span className="text-[10px] font-semibold uppercase tracking-widest"
                  style={{ color: v.color }}>
              Nivel de desempeño
            </span>
          </div>
          <p className="text-2xl font-bold leading-tight" style={{ color: v.color }}>
            {v.label}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] leading-snug">
            {v.description}
          </p>
          {/* Justificación concreta del nivel (data-driven) */}
          {v.reasons.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {v.reasons.map((r, i) => (
                <li key={i}
                    className="text-[11px] text-[var(--text)] leading-snug pl-3 relative">
                  <span className="absolute left-0 top-[7px] w-1 h-1 rounded-full"
                        style={{ background: v.color }} />
                  {r}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-[var(--text-muted)] font-mono mt-1">
            Ductilidad del proyecto: {v.ductility} · t ={" "}
            <span className={v.duration_ok ? "text-green-600" : "text-amber-600"}>
              {result.envelope.t_elapsed_s.toFixed(1)}/{result.envelope.t_target_s.toFixed(1)} s
            </span>
          </p>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-0">
          <KpiCell
            label="Deriva máxima"
            value={`${v.drift_max.toFixed(3)} %`}
            compare={`vs ${v.drift_limit}% NSR-10 ${v.ductility}`}
            ok={v.drift_ok}
          />
          <KpiCell
            label="Cortante basal máx"
            value={`${Math.max(result.envelope.max_Vb_x_kN, result.envelope.max_Vb_y_kN).toFixed(0)} kN`}
            compare={v.Vb_W_ratio !== null
              ? `${(v.Vb_W_ratio * 100).toFixed(1)}% del peso W`
              : "X: " + result.envelope.max_Vb_x_kN.toFixed(0) + " · Y: " + result.envelope.max_Vb_y_kN.toFixed(0)}
          />
          <KpiCell
            label="Desp. de techo"
            value={`${(result.envelope.max_roof_disp_total_m * 1000).toFixed(1)} mm`}
            compare={`X: ${(result.envelope.max_abs_disp_x_m*1000).toFixed(0)} · Y: ${(result.envelope.max_abs_disp_y_m*1000).toFixed(0)}`}
          />
          <KpiCell
            label={result.system === "walls" ? "Pieres críticos" : "Rótulas críticas"}
            value={`${v.n_crit_total} ${result.system === "walls" ? "pisos" : ""}`}
            compare={`de ${total_hinges} total · CP+Colapso`}
            ok={v.n_crit_total === 0}
          />
        </div>
      </div>
    </div>
  );
}

function KpiCell({ label, value, compare, ok }: {
  label: string; value: string; compare: string; ok?: boolean;
}) {
  const compareColor = ok === undefined ? "var(--text-muted)" : (ok ? "#16a34a" : "#dc2626");
  const compareIcon  = ok === undefined ? "" : (ok ? "✓ " : "✗ ");
  return (
    <div className="px-4 py-3 border-r border-b border-[var(--border)] bg-[var(--surface)] last:border-r-0">
      <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className="text-xl font-bold font-mono text-[var(--text)] leading-tight">
        {value}
      </p>
      <p className="text-[10px] mt-0.5 font-mono" style={{ color: compareColor }}>
        {compareIcon}{compare}
      </p>
    </div>
  );
}

function DamageSummary({ damage }: { damage: NLTHResult["damage"] }) {
  if (damage.status !== "success") {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-xs text-[var(--text-muted)]">Daño: datos no disponibles.</p>
      </div>
    );
  }

  const isHinges = "max_theta_p" in damage;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
          {isHinges ? "Rótulas plásticas (ASCE 41)" : "Daño por piso (Park-Ang)"}
        </h4>
        <span className="text-[10px] text-[var(--text-muted)] italic">{damage.scheme}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {isHinges ? (
          <>
            <Pill color="#22c55e" label="IO"       n={(damage as NLTHDamageHinges).counts.io} />
            <Pill color="#eab308" label="LS"       n={(damage as NLTHDamageHinges).counts.ls} />
            <Pill color="#f97316" label="CP"       n={(damage as NLTHDamageHinges).counts.cp} />
            <Pill color="#ef4444" label="Post-CP"  n={(damage as NLTHDamageHinges).counts.collapse} />
            <Pill color="#94a3b8" label="Sin daño" n={(damage as NLTHDamageHinges).counts.none} />
            <span className="ml-auto text-[11px] text-[var(--text-muted)] font-mono">
              θ_p máx = {(damage as NLTHDamageHinges).max_theta_p.toFixed(5)} rad
            </span>
          </>
        ) : (
          <>
            <Pill color="#22c55e" label="Menor"    n={(damage as NLTHDamagePiers).counts.minor} />
            <Pill color="#eab308" label="Moderado" n={(damage as NLTHDamagePiers).counts.moderate} />
            <Pill color="#f97316" label="Severo"   n={(damage as NLTHDamagePiers).counts.severe} />
            <Pill color="#ef4444" label="Colapso"  n={(damage as NLTHDamagePiers).counts.collapse} />
            <Pill color="#94a3b8" label="Sin daño" n={(damage as NLTHDamagePiers).counts.none} />
            <span className="ml-auto text-[11px] text-[var(--text-muted)] font-mono">
              DI máx = {(damage as NLTHDamagePiers).max_di.toFixed(3)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function HysteresisCard({ refEl }: { refEl: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="pl-glass rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Histéresis Vb vs δ_techo
          </h4>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
            Loops cerrados ⇒ disipación por fluencia / daño.
            Rama inclinada única ⇒ respuesta elástica.
            <span className="text-red-500 font-semibold"> ✕</span> marca el residual
            (δ permanente al final del sismo).
          </p>
        </div>
      </div>
      <div ref={refEl} style={{ height: 320 }} className="rounded" />
    </div>
  );
}

function OrbitCard({ refEl }: { refEl: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="pl-glass rounded-xl p-4 flex flex-col gap-2">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Órbita de techo (X vs Y)
      </h4>
      <p className="text-[11px] text-[var(--text-muted)]">
        Trayectoria del nodo de techo durante el sismo.
        <span className="text-amber-500 font-semibold"> ●</span> pico vectorial ·
        <span className="text-red-500 font-semibold"> ✕</span> residual ·
        <span className="text-red-500"> círculo</span> = límite NSR-10.
      </p>
      <div ref={refEl} style={{ height: 320 }} className="rounded" />
    </div>
  );
}

function PlotCard({ title, refEl }: {
  title: string; refEl: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="pl-glass rounded-xl p-4 flex flex-col gap-2">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h4>
      <div ref={refEl} style={{ height: 280 }} className="rounded" />
    </div>
  );
}

function ParamNumber({
  label, value, onChange, step = 0.1, min, max,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      <input type="number" step={step} min={min} max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono"
      />
    </label>
  );
}

function ParamSelect({
  label, value, onChange, options, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: Array<[string, string]>; disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      <select value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm disabled:opacity-60"
      >
        {options.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
    </label>
  );
}

function Pill({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span className="px-2 py-0.5 rounded font-mono text-[11px] flex items-center gap-1"
          style={{ background: `${color}22`, color }}>
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="font-semibold">{label}</span>
      <span>{n}</span>
    </span>
  );
}

function SystemBadge({ detected }: { detected: "walls" | "frames" | "mixed" | "unknown" }) {
  const labels: Record<typeof detected, [string, string]> = {
    walls:   ["Edificio de muros",       "#2563eb"],
    frames:  ["Edificio aporticado",     "#16a34a"],
    mixed:   ["Mixto (muros + pórticos)","#f59e0b"],
    unknown: ["Sistema sin detectar",    "#94a3b8"],
  };
  const [label, color] = labels[detected];
  return (
    <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold flex items-center gap-1.5"
          style={{ background: `${color}22`, color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Historial de análisis NLTH — lista de jobs navegables (Fase 1)
// ─────────────────────────────────────────────────────────────────────────────

function NLTHHistoryList({
  jobs, activeJobId, loadingJobId,
  onOpen, onActivate, onDelete, onExport, onImportClick,
}: {
  jobs:          NLTHJobMeta[];
  activeJobId:   string | null;
  loadingJobId:  string | null;
  onOpen:        (id: string) => void;
  onActivate:    (id: string) => void;
  onDelete:      (id: string) => void;
  onExport:      (job: NLTHJobMeta) => void;
  onImportClick: () => void;
}) {
  return (
    <section className="pl-glass-soft rounded-xl p-4 space-y-3">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Historial de análisis cronológicos ({jobs.length})
          </h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            Click en una tarjeta para revisar. "Fijar" lo activa para el
            verificador y exports. "Descargar" guarda un .json portable;
            "Importar" abre un .json externo en modo vista previa.
          </p>
        </div>
        <button
          type="button"
          onClick={onImportClick}
          className="text-xs px-3 py-1.5 rounded bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-600 dark:text-indigo-300 font-medium shrink-0"
        >
          📂 Importar JSON
        </button>
      </header>

      {jobs.length === 0 && (
        <div className="rounded-lg bg-[var(--panel-muted)]/40 p-6 text-center">
          <div className="text-xs text-[var(--text-muted)]">
            Aún no hay análisis guardados en este proyecto.
          </div>
          <div className="text-[11px] text-[var(--text-muted)] italic mt-1">
            Lanza un NLTH desde abajo, o importa un .json exportado previamente.
          </div>
        </div>
      )}

      {jobs.length > 0 && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-[420px] overflow-y-auto pr-1">
        {jobs.map((j) => {
          const isActive  = j.job_id === activeJobId;
          const isLoading = j.job_id === loadingJobId;
          const dateStr   = j.computed_at
            ? new Date(j.computed_at).toLocaleString("es-CO", {
                dateStyle: "short", timeStyle: "short",
              })
            : "—";
          const driftColor =
            j.max_drift_pct >= 2.0 ? "text-rose-500"
            : j.max_drift_pct >= 1.0 ? "text-amber-500"
            : "text-emerald-500";
          const residualColor =
            j.residual_drift_pct >= 0.5 ? "text-rose-500"
            : j.residual_drift_pct >= 0.2 ? "text-amber-500"
            : "text-emerald-500";
          const recordLabel = j.record_x_file === j.record_y_file
            ? j.record_x_file
            : `${j.record_x_file} / ${j.record_y_file}`;
          return (
            <article
              key={j.job_id}
              className={`rounded-lg p-3 border transition cursor-pointer ${
                isActive
                  ? "bg-indigo-500/10 border-indigo-500/50 shadow"
                  : "bg-[var(--panel-muted)]/40 border-transparent hover:border-[var(--panel-muted)]"
              } ${isLoading ? "opacity-60 pointer-events-none" : ""}`}
              onClick={() => onOpen(j.job_id)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="text-[9px] uppercase tracking-wider font-bold text-indigo-500 px-1.5 py-0.5 rounded bg-indigo-500/15">
                        viendo
                      </span>
                    )}
                    <span className="text-xs font-mono text-[var(--text)] truncate">
                      {recordLabel}
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    {dateStr} · {j.system === "walls" ? "muros" : "pórticos"} ·
                    {" "}scale = {j.scale.toFixed(3)} · wall = {j.wall_time_min.toFixed(1)} min
                  </div>
                </div>
                <span
                  className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${
                    j.status === "success"
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : j.status === "partial"
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {j.status}
                </span>
              </div>

              {/* KPIs breves */}
              <div className="grid grid-cols-4 gap-2 mt-2 text-[10px]">
                <div>
                  <div className="text-[9px] uppercase text-[var(--text-muted)]">Deriva máx</div>
                  <div className={`font-mono font-semibold ${driftColor}`}>
                    {j.max_drift_pct.toFixed(2)} %
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-[var(--text-muted)]">Residual</div>
                  <div className={`font-mono font-semibold ${residualColor}`}>
                    {j.residual_drift_pct.toFixed(2)} %
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-[var(--text-muted)]">PGA</div>
                  <div className="font-mono text-[var(--text)]">
                    {Math.max(j.pga_x_g, j.pga_y_g).toFixed(2)} g
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-[var(--text-muted)]">Vb pico</div>
                  <div className="font-mono text-[var(--text)]">
                    {j.Vb_peak_kN.toFixed(0)} kN
                  </div>
                </div>
              </div>

              {/* Acciones */}
              <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[var(--panel-muted)]/50">
                {!isActive && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(j.job_id); }}
                    className="text-[10px] px-2 py-0.5 rounded bg-[var(--panel-muted)] hover:bg-[var(--surface-2)] text-[var(--text)]"
                  >
                    Abrir
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onActivate(j.job_id); }}
                  className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-600 dark:text-indigo-300"
                  title="Fija este análisis como 'el último' — el verificador y los exports usarán este."
                >
                  Fijar
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onExport(j); }}
                  className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-600 dark:text-emerald-400"
                  title="Descarga un JSON autocontenido de este análisis."
                >
                  ↓ Descargar
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(j.job_id); }}
                  className="text-[10px] px-2 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/25 text-rose-600 dark:text-rose-400 ml-auto"
                >
                  Borrar
                </button>
              </div>

              {j.aborted && j.abort_reason && (
                <div className="mt-1.5 text-[9px] italic text-amber-600 dark:text-amber-400">
                  motor abortó: {j.abort_reason}
                </div>
              )}
            </article>
          );
        })}
      </div>
      )}
    </section>
  );
}
