"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { buildingAnalysisApi, buildingProjectsApi } from "@/lib/building-api";
import type {
  AnalysisType,
  BuildingJob,
  BuildingParameters,
  BuildingProject,
  DynamicParams,
  DynamicResult,
  ModalResult,
  PushoverParams,
  PushoverResult,
} from "@/lib/building-types";
import { useRequireAuth } from "@/lib/use-require-auth";
import { ModelViewer3D } from "@/components/building/ModelViewer3D";
import { ModalResultsTable } from "@/components/building/ModalResultsTable";
import { PushoverChart } from "@/components/building/PushoverChart";
import { DynamicResultsChart } from "@/components/building/DynamicResultsChart";

// ── Helpers ───────────────────────────────────────────────────────────────────

type JobStatus = BuildingJob["status"];

const STATUS_COLOR: Record<JobStatus, string> = {
  pending:   "var(--color-text-muted)",
  running:   "var(--color-warning)",
  success:   "var(--color-success)",
  failed:    "var(--color-danger)",
  cancelled: "var(--color-text-muted)",
};
const STATUS_LABEL: Record<JobStatus, string> = {
  pending:   "Pendiente",
  running:   "Procesando...",
  success:   "Completado",
  failed:    "Error",
  cancelled: "Cancelado",
};

function JobBadge({ status }: { status: JobStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {status === "running" && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: color }} />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

function SelectField({
  label, value, onChange, options, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Default params ─────────────────────────────────────────────────────────────

function defaultParams(projectName: string): BuildingParameters {
  return {
    proyect_name:       projectName,
    city:               "Bogotá",
    soil_type:          "D",
    edification_use:    "II",
    construction_year:  2020,
    code:               "NSR-10",
    structure_system:   "RCMRF",
    confined_elements:  "Si",
    energy_dissipation: "DMO",
    integration_points: 5,
    load_case:          "COMB1",
    cm_load:            "CM",
    cv_load:            "CV",
    shell_craking:      0.5,
    rebar_type:         "60",
  };
}

const defaultPushoverParams: PushoverParams = {
  pattern_type: "triangular",
  Dmax:         0.10,
  DInc:         0.001,
  tag_pattern:  1,
  odb_tag:      1,
  push_error:   1e-4,
  maxNumIter:   100,
};

const defaultDynamicParams: DynamicParams = {
  damping:        0.05,
  scale_factors:  [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0],
  n_pairs:        11,
  dt_analysis:    0.005,
  parallel_pairs: 2,
};

// ── Parameters form ────────────────────────────────────────────────────────────

function ParametersForm({
  initialParams, projectName, onSave, onCancel, saving,
}: {
  initialParams: BuildingParameters | null;
  projectName: string;
  onSave: (p: BuildingParameters) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [p, setP] = useState<BuildingParameters>(
    initialParams ?? defaultParams(projectName),
  );
  const set = <K extends keyof BuildingParameters>(k: K, v: BuildingParameters[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <Label>Nombre del proyecto</Label>
          <Input value={p.proyect_name} onChange={(e) => set("proyect_name", e.target.value)} />
        </div>
        <div>
          <Label>Ciudad</Label>
          <Input value={p.city} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div>
          <Label>Año de construcción</Label>
          <Input type="number" value={p.construction_year} onChange={(e) => set("construction_year", Number(e.target.value))} />
        </div>
        <SelectField
          label="Tipo de suelo"
          value={p.soil_type}
          onChange={(v) => set("soil_type", v)}
          options={["A","B","C","D","E"].map((s) => ({ value: s, label: `Suelo ${s}` }))}
        />
        <SelectField
          label="Uso de la edificación"
          value={p.edification_use}
          onChange={(v) => set("edification_use", v)}
          options={[
            { value: "I",   label: "Grupo I — Bajo riesgo" },
            { value: "II",  label: "Grupo II — Normal" },
            { value: "III", label: "Grupo III — Especial" },
            { value: "IV",  label: "Grupo IV — Indispensable" },
          ]}
        />
        <SelectField
          label="Sistema estructural"
          value={p.structure_system}
          onChange={(v) => set("structure_system", v)}
          options={[
            { value: "RCMRF", label: "RCMRF — Pórtico de concreto" },
            { value: "WRCF",  label: "WRCF — Muros de concreto" },
            { value: "DUAL",  label: "DUAL — Sistema dual" },
          ]}
        />
        <SelectField
          label="Disipación de energía"
          value={p.energy_dissipation}
          onChange={(v) => set("energy_dissipation", v)}
          options={[
            { value: "DES", label: "DES — Diseño elástico" },
            { value: "DMO", label: "DMO — Disipación moderada" },
            { value: "DES_ESP", label: "DES_ESP — Disipación especial" },
          ]}
        />
        <SelectField
          label="Elementos confinados"
          value={p.confined_elements}
          onChange={(v) => set("confined_elements", v)}
          options={[
            { value: "Si", label: "Si" },
            { value: "No", label: "No" },
          ]}
        />
        <SelectField
          label="Tipo de refuerzo"
          value={p.rebar_type}
          onChange={(v) => set("rebar_type", v)}
          options={[
            { value: "40", label: "Grado 40 (fy=276 MPa)" },
            { value: "60", label: "Grado 60 (fy=420 MPa)" },
          ]}
        />
        <div>
          <Label>Norma / Código</Label>
          <Input value={p.code} onChange={(e) => set("code", e.target.value)} />
        </div>
        <div>
          <Label>Caso de carga</Label>
          <Input value={p.load_case} onChange={(e) => set("load_case", e.target.value)} placeholder="COMB1" />
        </div>
        <div>
          <Label>Carga muerta (CM)</Label>
          <Input value={p.cm_load} onChange={(e) => set("cm_load", e.target.value)} placeholder="CM" />
        </div>
        <div>
          <Label>Carga viva (CV)</Label>
          <Input value={p.cv_load} onChange={(e) => set("cv_load", e.target.value)} placeholder="CV" />
        </div>
        <div>
          <Label>Factor agrietamiento losas</Label>
          <Input type="number" step="0.05" min={0} max={1} value={p.shell_craking} onChange={(e) => set("shell_craking", Number(e.target.value))} />
        </div>
        <div>
          <Label>Puntos de integración</Label>
          <Input type="number" min={3} max={10} value={p.integration_points} onChange={(e) => set("integration_points", Number(e.target.value))} />
        </div>
      </div>

      <div className="flex gap-3 border-t border-border pt-4">
        <Button onClick={() => onSave(p)} disabled={saving}>
          {saving ? "Guardando..." : "Guardar parámetros"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
      </div>
    </div>
  );
}

// ── File upload card ────────────────────────────────────────────────────────────

function UploadCard({
  label, accept, description, currentPath, uploading, onUpload,
}: {
  label: string;
  accept: string;
  description: string;
  currentPath: string | null;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileName = currentPath ? currentPath.split(/[\\/]/).pop() : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-text">{label}</p>
          <p className="text-[11px] text-text-muted">{description}</p>
        </div>
        {fileName && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--color-success)22", color: "var(--color-success)" }}>
            Cargado
          </span>
        )}
      </div>
      {fileName && (
        <p className="truncate font-mono text-[11px] text-text-muted">{fileName}</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="secondary"
          className="text-xs py-1.5 px-3 h-auto"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? "Cargando..." : fileName ? "Reemplazar" : "Seleccionar archivo"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function BuildingProjectDetailPage() {
  const ready  = useRequireAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  // Core state
  const [project, setProject]             = useState<BuildingProject | null>(null);
  const [jobs,    setJobs]                = useState<BuildingJob[]>([]);
  const [loading, setLoading]             = useState(true);
  const [error,   setError]               = useState<string | null>(null);

  // Results
  const [archetypeResult, setArchetypeResult] = useState<Record<string, unknown> | null>(null);
  const [modalResult,     setModalResult]     = useState<ModalResult | null>(null);
  const [pushoverResult,  setPushoverResult]  = useState<PushoverResult | null>(null);
  const [dynamicResult,   setDynamicResult]   = useState<DynamicResult | null>(null);

  // UI
  const [showParams,   setShowParams]   = useState(false);
  const [savingParams, setSavingParams] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<"model" | "e2k" | "rebar" | null>(null);
  const [launching, setLaunching]         = useState<AnalysisType | null>(null);
  const [jobError,  setJobError]          = useState<string | null>(null);

  // Pushover / dynamic param state
  const [pushoverParams, setPushoverParams] = useState<PushoverParams>(defaultPushoverParams);
  const [dynamicParams,  setDynamicParams]  = useState<DynamicParams>(defaultDynamicParams);
  const [showPushParams,  setShowPushParams]  = useState(false);
  const [showDynParams,   setShowDynParams]   = useState(false);

  // Polling
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const latestJob = useCallback(
    (type: AnalysisType) =>
      jobs.filter((j) => j.analysis_type === type).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )[0],
    [jobs],
  );

  const hasRunning = useCallback(
    () => jobs.some((j) => j.status === "pending" || j.status === "running"),
    [jobs],
  );

  // ── Fetch results for a given job ──────────────────────────────────────────

  const fetchResult = useCallback(async (job: BuildingJob) => {
    try {
      if (job.analysis_type === "archetype") {
        const r = await buildingAnalysisApi.result<Record<string, unknown>>(job.id);
        setArchetypeResult(r);
      } else if (job.analysis_type === "modal") {
        const r = await buildingAnalysisApi.result<ModalResult>(job.id);
        setModalResult(r);
      } else if (job.analysis_type === "pushover") {
        const r = await buildingAnalysisApi.result<PushoverResult>(job.id);
        setPushoverResult(r);
      } else if (job.analysis_type === "dynamic") {
        const r = await buildingAnalysisApi.result<DynamicResult>(job.id);
        setDynamicResult(r);
      }
    } catch {
      // result not available yet or failed — silently skip
    }
  }, []);

  // ── Fetch jobs + load results for successful ones ──────────────────────────

  const refreshJobs = useCallback(async () => {
    if (!id) return;
    try {
      const freshJobs = await buildingProjectsApi.jobs(id);
      setJobs(freshJobs);
      // Load results for any newly succeeded jobs
      for (const job of freshJobs) {
        if (job.status === "success") {
          await fetchResult(job);
        }
      }
    } catch {
      // ignore refresh errors silently
    }
  }, [id, fetchResult]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!ready || !id) return;
    (async () => {
      try {
        const [p, j] = await Promise.all([
          buildingProjectsApi.get(id),
          buildingProjectsApi.jobs(id),
        ]);
        setProject(p);
        setJobs(j);
        for (const job of j) {
          if (job.status === "success") await fetchResult(job);
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "No se pudo cargar el proyecto");
      } finally {
        setLoading(false);
      }
    })();
  }, [ready, id, fetchResult]);

  // ── Polling for running jobs ────────────────────────────────────────────────

  useEffect(() => {
    if (hasRunning()) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(refreshJobs, 3000);
      }
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [hasRunning, refreshJobs]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleSaveParams(params: BuildingParameters) {
    if (!id) return;
    setSavingParams(true);
    try {
      const updated = await buildingProjectsApi.saveParameters(id, params);
      setProject(updated);
      setShowParams(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al guardar parámetros");
    } finally {
      setSavingParams(false);
    }
  }

  async function handleUpload(type: "model" | "e2k" | "rebar", file: File) {
    if (!id) return;
    setUploadingFile(type);
    try {
      let updated: BuildingProject;
      if (type === "model")  updated = await buildingProjectsApi.uploadModel(id, file);
      else if (type === "e2k") updated = await buildingProjectsApi.uploadE2K(id, file);
      else                   updated = await buildingProjectsApi.uploadRebar(id, file);
      setProject(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al subir archivo");
    } finally {
      setUploadingFile(null);
    }
  }

  async function handleLaunch(
    type: AnalysisType,
    params?: { pushoverParams?: PushoverParams; dynamicParams?: DynamicParams },
  ) {
    if (!id) return;
    setLaunching(type);
    setJobError(null);
    try {
      const job = await buildingAnalysisApi.launch(id, type, params);
      setJobs((prev) => [job, ...prev]);
    } catch (e) {
      setJobError(e instanceof ApiError ? e.message : "Error al lanzar análisis");
    } finally {
      setLaunching(null);
    }
  }

  async function handleCancel(jobId: string) {
    try {
      await buildingAnalysisApi.cancel(jobId);
      await refreshJobs();
    } catch {
      // ignore
    }
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  const archetypeJob  = latestJob("archetype");
  const modalJob      = latestJob("modal");
  const pushoverJob   = latestJob("pushover");
  const dynamicJob    = latestJob("dynamic");

  const hasModel      = !!(project?.input_file_path || project?.e2k_file_path);
  const hasParams     = !!project?.parameters_json;
  const archetypeOk   = archetypeJob?.status === "success";
  const modalOk       = modalJob?.status === "success";

  const canRunArchetype = hasModel && hasParams && !hasRunning();
  const canRunModal     = archetypeOk && !hasRunning();
  const canRunPushover  = archetypeOk && !hasRunning();
  const canRunDynamic   = modalOk && !hasRunning();

  // ── Render guards ────────────────────────────────────────────────────────────

  if (!ready) return null;

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <AppHeader crumb="Análisis No Lineal 3D" />
        <main className="flex flex-1 items-center justify-center">
          <p className="text-sm text-text-muted">Cargando proyecto...</p>
        </main>
      </div>
    );
  }

  if (error && !project) {
    return (
      <div className="flex flex-1 flex-col">
        <AppHeader crumb="Análisis No Lineal 3D" />
        <main className="flex flex-1 items-center justify-center">
          <p className="text-sm text-danger">{error}</p>
        </main>
      </div>
    );
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  function ElapsedBadge({ job }: { job: BuildingJob }) {
    if (!job.finished_at) return null;
    const secs = Math.round(
      (new Date(job.finished_at).getTime() - new Date(job.created_at).getTime()) / 1000,
    );
    const label = secs < 60 ? `${secs}s` : `${(secs / 60).toFixed(1)} min`;
    return <span className="text-[11px] text-text-muted">{label}</span>;
  }

  function StepHeader({
    num, title, job, children,
  }: {
    num: number;
    title: string;
    job?: BuildingJob;
    children?: React.ReactNode;
  }) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
          style={{
            background: job?.status === "success"
              ? "var(--color-success)22"
              : "var(--color-border)",
            color: job?.status === "success"
              ? "var(--color-success)"
              : "var(--color-text-muted)",
          }}
        >
          {num}
        </span>
        <span className="text-sm font-semibold text-text">{title}</span>
        {job && <JobBadge status={job.status} />}
        {job && <ElapsedBadge job={job} />}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Análisis No Lineal 3D" />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">

        {/* Breadcrumb + title */}
        <div className="mb-6">
          <Link href="/building" className="text-xs text-text-muted hover:text-accent transition-colors">
            ← Todos los proyectos
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-text">{project?.name}</h1>
          {project?.description && (
            <p className="mt-0.5 text-sm text-text-muted">{project.description}</p>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {jobError && (
          <div className="mb-4 rounded-md border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
            {jobError}
          </div>
        )}

        <div className="flex flex-col gap-6">

          {/* ── Configuración ─────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text">Configuración del proyecto</h2>
                <div className="flex gap-2">
                  {hasParams && (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--color-success)22", color: "var(--color-success)" }}>
                      Parámetros guardados
                    </span>
                  )}
                  <Button
                    variant="secondary"
                    className="text-xs py-1 px-3 h-auto"
                    onClick={() => setShowParams((v) => !v)}
                  >
                    {showParams ? "Cerrar" : hasParams ? "Editar parámetros" : "Configurar parámetros"}
                  </Button>
                </div>
              </div>
            </CardHeader>

            <CardBody className="flex flex-col gap-4">
              {/* File uploads */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <UploadCard
                  label="Modelo ETABS (.xlsx)"
                  accept=".xlsx,.xls"
                  description="Exportación de tablas ETABS en Excel"
                  currentPath={project?.input_file_path ?? null}
                  uploading={uploadingFile === "model"}
                  onUpload={(f) => handleUpload("model", f)}
                />
                <UploadCard
                  label="Archivo E2K"
                  accept=".e2k,.E2K,.txt"
                  description="Exportación .e2k desde ETABS"
                  currentPath={project?.e2k_file_path ?? null}
                  uploading={uploadingFile === "e2k"}
                  onUpload={(f) => handleUpload("e2k", f)}
                />
                <UploadCard
                  label="Refuerzo (.xlsx)"
                  accept=".xlsx,.xls"
                  description="Tabla de refuerzo longitudinal"
                  currentPath={project?.rebar_file_path ?? null}
                  uploading={uploadingFile === "rebar"}
                  onUpload={(f) => handleUpload("rebar", f)}
                />
              </div>

              {/* Parameters form */}
              {showParams && (
                <div className="border-t border-border pt-4">
                  <ParametersForm
                    initialParams={project?.parameters_json ?? null}
                    projectName={project?.name ?? ""}
                    onSave={handleSaveParams}
                    onCancel={() => setShowParams(false)}
                    saving={savingParams}
                  />
                </div>
              )}

              {!hasModel && (
                <p className="text-xs text-warning">
                  Sube al menos un archivo de modelo (ETABS xlsx o E2K) para habilitar los análisis.
                </p>
              )}
              {!hasParams && (
                <p className="text-xs text-warning">
                  Configura los parámetros NSR-10 del proyecto antes de ejecutar el análisis.
                </p>
              )}
            </CardBody>
          </Card>

          {/* ── Paso 1: Arquetipo ──────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <StepHeader num={1} title="Generación del arquetipo" job={archetypeJob}>
                {archetypeJob?.status === "running" || archetypeJob?.status === "pending" ? (
                  <Button
                    variant="secondary"
                    className="text-xs py-1 px-3 h-auto"
                    onClick={() => handleCancel(archetypeJob.id)}
                  >
                    Cancelar
                  </Button>
                ) : (
                  <Button
                    className="text-xs py-1 px-3 h-auto"
                    disabled={!canRunArchetype || launching === "archetype"}
                    onClick={() => handleLaunch("archetype")}
                  >
                    {launching === "archetype" ? "Iniciando..." : archetypeOk ? "Re-ejecutar" : "Ejecutar"}
                  </Button>
                )}
              </StepHeader>
            </CardHeader>

            <CardBody>
              {archetypeJob?.status === "failed" && (
                <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {archetypeJob.error_message ?? "Error desconocido"}
                </div>
              )}

              {archetypeJob?.status === "running" && (
                <p className="text-sm text-text-muted">
                  Procesando modelo ETABS y construyendo arquetipo OpenSees...
                </p>
              )}

              {archetypeResult && (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-text-muted">
                    Modelo generado correctamente. Usa el visor 3D para verificar la geometría antes de continuar.
                  </p>
                  <ModelViewer3D archetypeData={archetypeResult} />
                </div>
              )}

              {!archetypeJob && (
                <p className="text-sm text-text-muted">
                  {!hasModel || !hasParams
                    ? "Sube el modelo y configura los parámetros para habilitar este análisis."
                    : "Ejecuta el análisis para construir el modelo OpenSees a partir del archivo ETABS."}
                </p>
              )}
            </CardBody>
          </Card>

          {/* ── Paso 2: Análisis Modal ─────────────────────────────────── */}
          <Card>
            <CardHeader>
              <StepHeader num={2} title="Análisis Modal" job={modalJob}>
                {modalJob?.status === "running" || modalJob?.status === "pending" ? (
                  <Button
                    variant="secondary"
                    className="text-xs py-1 px-3 h-auto"
                    onClick={() => handleCancel(modalJob.id)}
                  >
                    Cancelar
                  </Button>
                ) : (
                  <Button
                    className="text-xs py-1 px-3 h-auto"
                    disabled={!canRunModal || launching === "modal"}
                    onClick={() => handleLaunch("modal")}
                  >
                    {launching === "modal" ? "Iniciando..." : modalOk ? "Re-ejecutar" : "Ejecutar"}
                  </Button>
                )}
              </StepHeader>
            </CardHeader>

            <CardBody>
              {modalJob?.status === "failed" && (
                <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {modalJob.error_message ?? "Error desconocido"}
                </div>
              )}

              {modalJob?.status === "running" && (
                <p className="text-sm text-text-muted">
                  Ejecutando análisis de valores propios (eigenvalues)...
                </p>
              )}

              {modalResult ? (
                <ModalResultsTable data={modalResult} />
              ) : (
                !modalJob && (
                  <p className="text-sm text-text-muted">
                    {!archetypeOk
                      ? "Completa el análisis de arquetipo (Paso 1) para habilitar el análisis modal."
                      : "Ejecuta el análisis modal para obtener períodos y formas modales."}
                  </p>
                )
              )}
            </CardBody>
          </Card>

          {/* ── Paso 3: Pushover ──────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <StepHeader num={3} title="Análisis Pushover (X e Y)" job={pushoverJob}>
                <Button
                  variant="ghost"
                  className="text-xs py-1 px-2 h-auto"
                  onClick={() => setShowPushParams((v) => !v)}
                  disabled={!archetypeOk}
                >
                  Parámetros
                </Button>
                {pushoverJob?.status === "running" || pushoverJob?.status === "pending" ? (
                  <Button
                    variant="secondary"
                    className="text-xs py-1 px-3 h-auto"
                    onClick={() => handleCancel(pushoverJob.id)}
                  >
                    Cancelar
                  </Button>
                ) : (
                  <Button
                    className="text-xs py-1 px-3 h-auto"
                    disabled={!canRunPushover || launching === "pushover"}
                    onClick={() => handleLaunch("pushover", { pushoverParams })}
                  >
                    {launching === "pushover" ? "Iniciando..." : pushoverJob?.status === "success" ? "Re-ejecutar" : "Ejecutar"}
                  </Button>
                )}
              </StepHeader>
            </CardHeader>

            <CardBody className="flex flex-col gap-4">
              {showPushParams && (
                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Parámetros de Pushover</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <SelectField
                      label="Patrón de carga"
                      value={pushoverParams.pattern_type}
                      onChange={(v) => setPushoverParams((p) => ({ ...p, pattern_type: v as PushoverParams["pattern_type"] }))}
                      options={[
                        { value: "uniforme",   label: "Uniforme" },
                        { value: "triangular", label: "Triangular" },
                        { value: "modal",      label: "Modal" },
                      ]}
                    />
                    <div>
                      <Label>Deriva máx (fracción)</Label>
                      <Input type="number" step="0.01" value={pushoverParams.Dmax} onChange={(e) => setPushoverParams((p) => ({ ...p, Dmax: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Incremento desplaz.</Label>
                      <Input type="number" step="0.0001" value={pushoverParams.DInc} onChange={(e) => setPushoverParams((p) => ({ ...p, DInc: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Tag patrón</Label>
                      <Input type="number" value={pushoverParams.tag_pattern} onChange={(e) => setPushoverParams((p) => ({ ...p, tag_pattern: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Error convergencia</Label>
                      <Input type="number" value={pushoverParams.push_error} onChange={(e) => setPushoverParams((p) => ({ ...p, push_error: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Iteraciones máx</Label>
                      <Input type="number" value={pushoverParams.maxNumIter} onChange={(e) => setPushoverParams((p) => ({ ...p, maxNumIter: Number(e.target.value) }))} />
                    </div>
                  </div>
                </div>
              )}

              {pushoverJob?.status === "failed" && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {pushoverJob.error_message ?? "Error desconocido"}
                </div>
              )}

              {pushoverJob?.status === "running" && (
                <p className="text-sm text-text-muted">
                  Ejecutando pushover en paralelo para dirección X e Y...
                </p>
              )}

              {pushoverResult ? (
                <PushoverChart data={pushoverResult} />
              ) : (
                !pushoverJob && (
                  <p className="text-sm text-text-muted">
                    {!archetypeOk
                      ? "Completa el análisis de arquetipo (Paso 1) para habilitar el pushover."
                      : "Ejecuta el análisis pushover para obtener las curvas de capacidad."}
                  </p>
                )
              )}
            </CardBody>
          </Card>

          {/* ── Paso 4: Dinámico IDA ──────────────────────────────────── */}
          <Card>
            <CardHeader>
              <StepHeader num={4} title="Análisis Dinámico No Lineal (IDA)" job={dynamicJob}>
                <Button
                  variant="ghost"
                  className="text-xs py-1 px-2 h-auto"
                  onClick={() => setShowDynParams((v) => !v)}
                  disabled={!modalOk}
                >
                  Parámetros
                </Button>
                {dynamicJob?.status === "running" || dynamicJob?.status === "pending" ? (
                  <Button
                    variant="secondary"
                    className="text-xs py-1 px-3 h-auto"
                    onClick={() => handleCancel(dynamicJob.id)}
                  >
                    Cancelar
                  </Button>
                ) : (
                  <Button
                    className="text-xs py-1 px-3 h-auto"
                    disabled={!canRunDynamic || launching === "dynamic"}
                    onClick={() => handleLaunch("dynamic", { dynamicParams })}
                  >
                    {launching === "dynamic" ? "Iniciando..." : dynamicJob?.status === "success" ? "Re-ejecutar" : "Ejecutar"}
                  </Button>
                )}
              </StepHeader>
            </CardHeader>

            <CardBody className="flex flex-col gap-4">
              {showDynParams && (
                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Parámetros Dinámicos</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div>
                      <Label>Amortiguamiento</Label>
                      <Input type="number" step="0.01" value={dynamicParams.damping} onChange={(e) => setDynamicParams((p) => ({ ...p, damping: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Pares de registros</Label>
                      <Input type="number" min={1} max={22} value={dynamicParams.n_pairs} onChange={(e) => setDynamicParams((p) => ({ ...p, n_pairs: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Dt análisis (s)</Label>
                      <Input type="number" step="0.001" value={dynamicParams.dt_analysis} onChange={(e) => setDynamicParams((p) => ({ ...p, dt_analysis: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <Label>Pares en paralelo</Label>
                      <Input type="number" min={1} max={4} value={dynamicParams.parallel_pairs} onChange={(e) => setDynamicParams((p) => ({ ...p, parallel_pairs: Number(e.target.value) }))} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label>Factores de escala (separados por coma)</Label>
                      <Input
                        value={dynamicParams.scale_factors.join(", ")}
                        onChange={(e) => {
                          const vals = e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
                          setDynamicParams((p) => ({ ...p, scale_factors: vals }));
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {dynamicJob?.status === "failed" && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {dynamicJob.error_message ?? "Error desconocido"}
                </div>
              )}

              {dynamicJob?.status === "running" && (
                <p className="text-sm text-text-muted">
                  Ejecutando análisis dinámico no lineal con registros FEMA P-695... Este proceso puede tardar varios minutos.
                </p>
              )}

              {dynamicResult ? (
                <DynamicResultsChart data={dynamicResult} />
              ) : (
                !dynamicJob && (
                  <p className="text-sm text-text-muted">
                    {!modalOk
                      ? "Completa el análisis modal (Paso 2) para habilitar el análisis dinámico IDA."
                      : "Ejecuta el análisis dinámico para obtener la envolvente de derivas y la curva IDA."}
                  </p>
                )
              )}
            </CardBody>
          </Card>

        </div>
      </main>
    </div>
  );
}
