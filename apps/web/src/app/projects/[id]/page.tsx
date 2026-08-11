"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ValidationReport } from "@/components/linear/ValidationReport";
import { LoadPatternSelector } from "@/components/linear/LoadPatternSelector";
import { LinearModelViewer3D } from "@/components/linear/LinearModelViewer3D";
import { SeismicParamsForm } from "@/components/linear/SeismicParamsForm";
import { SpectrumPreview } from "@/components/linear/SpectrumPreview";
import { ModalResultsTable } from "@/components/linear/ModalResultsTable";
import { SpectralResultsPanel } from "@/components/linear/SpectralResultsPanel";
import { ApiError } from "@/lib/api";
import { structuralProjectsApi, structuralAnalysisApi } from "@/lib/structural-api";
import type {
  StructuralProject,
  StructuralJob,
  StructuralJobStatus,
  ValidationStatus,
  ValidationResult,
  SeismicParameters,
  SpectrumPreviewResult,
  ModalResult,
  SpectralResult,
  ModelGeometry,
} from "@/lib/structural-types";
import { useRequireAuth } from "@/lib/use-require-auth";

// ── Tipos de tab ──────────────────────────────────────────────────────────────

type TabId = "model" | "seismic" | "design" | "nonlinear";

interface Tab {
  id: TabId;
  label: string;
  locked?: boolean;
  lockReason?: string;
}

const TABS: Tab[] = [
  { id: "model",     label: "Modelo" },
  { id: "seismic",   label: "Análisis Sísmico" },
  { id: "design",    label: "Diseño", locked: true, lockReason: "Próximamente" },
  { id: "nonlinear", label: "Modelo NL", locked: true, lockReason: "Próximamente" },
];

// ── Helpers visuales ──────────────────────────────────────────────────────────

const VALIDATION_INFO: Record<ValidationStatus, { label: string; color: string }> = {
  not_run:      { label: "Sin validar",       color: "var(--color-text-muted)" },
  has_errors:   { label: "Errores críticos",  color: "var(--color-danger)" },
  has_warnings: { label: "Con advertencias",  color: "var(--color-warning)" },
  ok:           { label: "Validado",          color: "var(--color-success)" },
};

const JOB_STATUS_LABEL: Record<StructuralJobStatus, string> = {
  pending:   "En cola...",
  running:   "Ejecutando...",
  success:   "Completado",
  failed:    "Error",
  cancelled: "Cancelado",
};

function JobStatusBadge({ status }: { status: StructuralJobStatus }) {
  const colors: Record<StructuralJobStatus, string> = {
    pending:   "var(--color-text-muted)",
    running:   "var(--color-accent)",
    success:   "var(--color-success)",
    failed:    "var(--color-danger)",
    cancelled: "var(--color-text-muted)",
  };
  const color = colors[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {JOB_STATUS_LABEL[status]}
    </span>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function StructuralProjectPage() {
  const ready = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [project, setProject]     = useState<StructuralProject | null>(null);
  const [jobs, setJobs]           = useState<StructuralJob[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("model");
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // Estado de subida de archivo
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [dragOverXlsx, setDragOverXlsx] = useState(false);
  const [dragOverE2k, setDragOverE2k]   = useState(false);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const e2kFileRef   = useRef<HTMLInputElement>(null);

  // Geometría del modelo 3D
  const [modelGeometry, setModelGeometry]       = useState<ModelGeometry | null>(null);
  const [loadingGeometry, setLoadingGeometry]   = useState(false);

  // Estado de lanzamiento de job
  const [launching, setLaunching] = useState<string | null>(null);

  // Resultado de validación cargado
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loadingValidation, setLoadingValidation] = useState(false);

  // Espectro NSR-10 para previsualización
  const [spectrumData, setSpectrumData]       = useState<SpectrumPreviewResult | null>(null);
  const [spectrumLoading, setSpectrumLoading] = useState(false);

  // Resultado del análisis modal
  const [modalResult, setModalResult]         = useState<ModalResult | null>(null);

  // Resultado del análisis espectral
  const [spectralResult, setSpectralResult]   = useState<SpectralResult | null>(null);

  // Polling ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cargar geometría del modelo cuando el proyecto tiene modelo canónico
  const loadModelGeometry = useCallback(async (proj: StructuralProject) => {
    if (!proj.canonical_model_path) return;
    setLoadingGeometry(true);
    try {
      const geo = await structuralProjectsApi.modelGeometry(proj.id);
      setModelGeometry(geo);
    } catch { /* silencioso */ } finally {
      setLoadingGeometry(false);
    }
  }, []);

  // Carga inicial
  useEffect(() => {
    if (!ready || !params.id) return;
    Promise.all([
      structuralProjectsApi.get(params.id),
      structuralProjectsApi.jobs(params.id),
    ])
      .then(([proj, jobList]) => {
        setProject(proj);
        setJobs(jobList);
        if (proj.canonical_model_path) loadModelGeometry(proj);
      })
      .catch(() => setError("No se pudo cargar el proyecto"))
      .finally(() => setLoading(false));
  }, [ready, params.id, loadModelGeometry]);

  // Cargar resultado de validación cuando hay un job de import exitoso
  const loadValidationResult = useCallback(async (jobList: StructuralJob[]) => {
    const importJob = jobList.find((j) => j.analysis_type === "import_validate" && j.status === "success");
    if (!importJob) return;
    setLoadingValidation(true);
    try {
      const result = await structuralAnalysisApi.result<ValidationResult>(importJob.id);
      setValidationResult(result);
    } catch { /* silencioso */ } finally {
      setLoadingValidation(false);
    }
  }, []);

  // Cargar resultado modal cuando hay un job modal exitoso
  const loadModalResult = useCallback(async (jobList: StructuralJob[]) => {
    const modalJob = jobList.find((j) => j.analysis_type === "modal" && j.status === "success");
    if (!modalJob) return;
    try {
      const result = await structuralAnalysisApi.result<ModalResult>(modalJob.id);
      setModalResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar resultado espectral cuando hay un job espectral exitoso
  const loadSpectralResult = useCallback(async (jobList: StructuralJob[]) => {
    const spectralJob = jobList.find((j) => j.analysis_type === "spectral" && j.status === "success");
    if (!spectralJob) return;
    try {
      const result = await structuralAnalysisApi.result<SpectralResult>(spectralJob.id);
      setSpectralResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Polling mientras haya jobs activos
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === "pending" || j.status === "running");
    if (!hasActive) {
      if (pollRef.current) clearInterval(pollRef.current);
      if (!validationResult)  loadValidationResult(jobs);
      if (!modalResult)       loadModalResult(jobs);
      if (!spectralResult)    loadSpectralResult(jobs);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const [proj, jobList] = await Promise.all([
          structuralProjectsApi.get(params.id),
          structuralProjectsApi.jobs(params.id),
        ]);
        setProject(proj);
        setJobs(jobList);
        if (!validationResult)  loadValidationResult(jobList);
        if (!modalResult)       loadModalResult(jobList);
        if (!spectralResult)    loadSpectralResult(jobList);
        if (!modelGeometry && proj.canonical_model_path) loadModelGeometry(proj);
      } catch {
        // silencioso en polling
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobs, params.id, validationResult, modalResult, spectralResult, modelGeometry,
      loadValidationResult, loadModalResult, loadSpectralResult, loadModelGeometry]);

  // ── Acciones ───────────────────────────────────────────────────────────────

  async function handleUpload(file: File, type: "model" | "e2k") {
    if (!project) return;
    setUploading(true);
    setUploadError(null);
    try {
      const updated = type === "model"
        ? await structuralProjectsApi.uploadModel(project.id, file)
        : await structuralProjectsApi.uploadE2K(project.id, file);
      setProject(updated);
      setModelGeometry(null);
      setValidationResult(null);
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : "Error al subir el archivo");
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: React.DragEvent, type: "model" | "e2k") {
    e.preventDefault();
    setDragOverXlsx(false);
    setDragOverE2k(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
    const isE2k  = file.name.toLowerCase().endsWith(".e2k");
    if (type === "model" && isXlsx) { handleUpload(file, "model"); return; }
    if (type === "e2k"  && isE2k)  { handleUpload(file, "e2k");   return; }
    if (isXlsx) { handleUpload(file, "model"); return; }
    if (isE2k)  { handleUpload(file, "e2k");   return; }
    setUploadError(`Formato no soportado: ${file.name}. Acepta .xlsx o .e2k`);
  }

  async function handleSaveLoadPatterns(cm: string, cv: string) {
    if (!project) return;
    const current = project.parameters_json ?? {
      code: "NSR-10", city: "", soil_type: "C",
      edification_use: "II", importance_factor: 1.0,
      structure_system: "RCMRF", energy_dissipation: "DMO",
      damping_ratio: 0.05, n_modes: 12, combination_method: "CQC",
      cm_load: "DEAD", cv_load: "LIVE",
    } as SeismicParameters;
    const updated = await structuralProjectsApi.saveParameters(project.id, {
      ...current,
      cm_load: cm,
      cv_load: cv,
    });
    setProject(updated);
  }

  async function handleLaunch(analysisType: "import_validate" | "modal" | "spectral") {
    if (!project) return;
    setLaunching(analysisType);
    try {
      const job = await structuralAnalysisApi.launch(project.id, analysisType);
      setJobs((prev) => [job, ...prev]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al lanzar el análisis");
    } finally {
      setLaunching(null);
    }
  }

  async function handleSpectrumPreview({ Aa, Av, soil_type }: { Aa: number; Av: number; soil_type: string }) {
    if (!project) return;
    setSpectrumLoading(true);
    try {
      const data = await structuralProjectsApi.spectrumPreview(project.id, Aa, Av, soil_type);
      setSpectrumData(data);
    } catch (e) {
      console.error("Error al generar espectro:", e);
    } finally {
      setSpectrumLoading(false);
    }
  }

  function handleParamsSaved(params: SeismicParameters) {
    setProject((prev) => prev ? { ...prev, parameters_json: params } : prev);
  }

  async function handleCancel(jobId: string) {
    try {
      await structuralAnalysisApi.cancel(jobId);
      const jobList = await structuralProjectsApi.jobs(params.id);
      setJobs(jobList);
    } catch { /* silencioso */ }
  }

  // ── Estados de proyecto ────────────────────────────────────────────────────

  const hasFile        = !!(project?.input_file_path || project?.e2k_file_path);
  const isValidated    = project?.validation_status === "ok" || project?.validation_status === "has_warnings";
  const hasModal       = jobs.some((j) => j.analysis_type === "modal" && j.status === "success");
  const hasSpectral    = jobs.some((j) => j.analysis_type === "spectral" && j.status === "success");
  const activeJobTypes = new Set(
    jobs.filter((j) => j.status === "pending" || j.status === "running").map((j) => j.analysis_type)
  );

  const lastJobByType = (type: string) =>
    jobs.find((j) => j.analysis_type === type);

  if (!ready) return null;

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <AppHeader crumb="Constructor de Modelos" />
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          <p className="text-sm text-text-muted">Cargando proyecto...</p>
        </main>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex flex-1 flex-col">
        <AppHeader crumb="Constructor de Modelos" />
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          <p className="text-sm text-danger">{error ?? "Proyecto no encontrado"}</p>
          <Button className="mt-4" variant="ghost" onClick={() => router.push("/projects")}>
            ← Volver a proyectos
          </Button>
        </main>
      </div>
    );
  }

  const validationInfo = VALIDATION_INFO[project.validation_status];

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Constructor de Modelos" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">

        {/* Breadcrumb + título */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
            <Link href="/projects" className="hover:text-accent transition-colors">Proyectos</Link>
            <span>/</span>
            <span className="text-text">{project.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-text">{project.name}</h1>
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: `${validationInfo.color}22`, color: validationInfo.color }}
            >
              {validationInfo.label}
            </span>
          </div>
          {project.description && (
            <p className="mt-1 text-sm text-text-muted">{project.description}</p>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border mb-8 gap-0">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const isLocked = tab.locked;
            return (
              <button
                key={tab.id}
                onClick={() => !isLocked && setActiveTab(tab.id)}
                className={[
                  "relative px-5 py-3 text-sm font-medium transition-colors",
                  isLocked
                    ? "text-text-muted cursor-not-allowed opacity-50"
                    : isActive
                    ? "text-accent border-b-2 border-accent -mb-px"
                    : "text-text-muted hover:text-text",
                ].join(" ")}
                title={isLocked ? tab.lockReason : undefined}
              >
                {tab.label}
                {isLocked && (
                  <span className="ml-2 text-[9px] font-normal opacity-70">
                    {tab.lockReason}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Tab: Modelo ───────────────────────────────────────────────────── */}
        {activeTab === "model" && (
          <div className="flex flex-col gap-6">

            {/* Sección: Cargar modelo */}
            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-text">Archivo de modelo</h2>
                <p className="text-xs text-text-muted mt-0.5">
                  Sube el exportado de ETABS en formato XLSX o .e2k
                </p>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">

                {/* inputs ocultos */}
                <input ref={modelFileRef} type="file" accept=".xlsx" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, "model"); e.target.value = ""; }} />
                <input ref={e2kFileRef}   type="file" accept=".e2k"  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, "e2k");   e.target.value = ""; }} />

                <div className="grid grid-cols-2 gap-4">
                  {/* Zona XLSX */}
                  <div
                    onClick={() => !uploading && modelFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOverXlsx(true); }}
                    onDragLeave={() => setDragOverXlsx(false)}
                    onDrop={(e) => handleDrop(e, "model")}
                    className={[
                      "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors min-h-[140px]",
                      dragOverXlsx
                        ? "border-accent bg-accent/5"
                        : project.input_file_path
                        ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5 hover:border-[var(--color-success)]"
                        : "border-border bg-surface-2 hover:border-accent hover:bg-accent/5",
                    ].join(" ")}
                  >
                    <span className="text-2xl mb-2 select-none">
                      {project.input_file_path ? "✅" : "📊"}
                    </span>
                    <p className="text-sm font-medium text-text text-center">
                      {project.input_file_path ? "Modelo XLSX cargado" : "Modelo ETABS (.xlsx)"}
                    </p>
                    <p className="text-[11px] text-text-muted text-center mt-1">
                      {project.input_file_path
                        ? "Clic o arrastra para reemplazar"
                        : "Arrastra aquí o haz clic para seleccionar"}
                    </p>
                    <p className="text-[10px] text-text-muted mt-1 opacity-70">
                      File → Export → Excel Spreadsheet
                    </p>
                    {dragOverXlsx && (
                      <div className="absolute inset-0 rounded-xl bg-accent/10 flex items-center justify-center">
                        <p className="text-accent font-semibold text-sm">Suelta para subir</p>
                      </div>
                    )}
                  </div>

                  {/* Zona E2K */}
                  <div
                    onClick={() => !uploading && e2kFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOverE2k(true); }}
                    onDragLeave={() => setDragOverE2k(false)}
                    onDrop={(e) => handleDrop(e, "e2k")}
                    className={[
                      "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors min-h-[140px]",
                      dragOverE2k
                        ? "border-accent bg-accent/5"
                        : project.e2k_file_path
                        ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5 hover:border-[var(--color-success)]"
                        : "border-border bg-surface-2 hover:border-accent hover:bg-accent/5",
                    ].join(" ")}
                  >
                    <span className="text-2xl mb-2 select-none">
                      {project.e2k_file_path ? "✅" : "📄"}
                    </span>
                    <p className="text-sm font-medium text-text text-center">
                      {project.e2k_file_path ? "Archivo .e2k cargado" : "ETABS Text (.e2k)"}
                    </p>
                    <p className="text-[11px] text-text-muted text-center mt-1">
                      {project.e2k_file_path
                        ? "Clic o arrastra para reemplazar"
                        : "Arrastra aquí o haz clic para seleccionar"}
                    </p>
                    <p className="text-[10px] text-text-muted mt-1 opacity-70">
                      File → Export → ETABS Text File
                    </p>
                    {dragOverE2k && (
                      <div className="absolute inset-0 rounded-xl bg-accent/10 flex items-center justify-center">
                        <p className="text-accent font-semibold text-sm">Suelta para subir</p>
                      </div>
                    )}
                  </div>
                </div>

                {uploadError && (
                  <p className="text-sm text-danger">{uploadError}</p>
                )}
                {uploading && (
                  <p className="text-sm text-text-muted animate-pulse">Subiendo archivo...</p>
                )}
              </CardBody>
            </Card>

            {/* Sección: Validar modelo */}
            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-text">Validación del modelo</h2>
                <p className="text-xs text-text-muted mt-0.5">
                  Verifica la integridad del modelo antes de ejecutar análisis
                </p>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">

                {!hasFile ? (
                  <div className="rounded-lg border border-border bg-surface-2 p-6 text-center">
                    <p className="text-sm text-text-muted">
                      Sube un archivo de modelo para poder validar
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Estado de validación */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ background: validationInfo.color }}
                        />
                        <span className="text-sm text-text">{validationInfo.label}</span>
                      </div>
                      <Button
                        onClick={() => handleLaunch("import_validate")}
                        disabled={activeJobTypes.has("import_validate") || !!launching}
                      >
                        {activeJobTypes.has("import_validate")
                          ? "Validando..."
                          : project.validation_status === "not_run"
                          ? "Validar modelo"
                          : "Revalidar"}
                      </Button>
                    </div>

                    {/* Resultado de la última validación */}
                    {(() => {
                      const lastValidation = lastJobByType("import_validate");
                      if (!lastValidation) return null;

                      if (lastValidation.status === "failed") {
                        return (
                          <div className="rounded-lg border border-danger bg-surface-2 p-4">
                            <p className="text-xs font-semibold text-danger mb-1">Error en la tarea</p>
                            <pre className="text-[11px] text-text-muted whitespace-pre-wrap line-clamp-6">
                              {lastValidation.error_message}
                            </pre>
                          </div>
                        );
                      }

                      if (lastValidation.status === "running" || lastValidation.status === "pending") {
                        return (
                          <div className="rounded-lg border border-border bg-surface-2 p-4 text-center">
                            <p className="text-sm text-text-muted">Validando el modelo...</p>
                          </div>
                        );
                      }

                      if (lastValidation.status === "success") {
                        if (loadingValidation) {
                          return (
                            <div className="rounded-lg border border-border bg-surface-2 p-4 text-center">
                              <p className="text-sm text-text-muted">Cargando resultados...</p>
                            </div>
                          );
                        }
                        if (validationResult) {
                          return <ValidationReport report={validationResult} />;
                        }
                      }

                      return null;
                    })()}
                  </>
                )}
              </CardBody>
            </Card>

            {/* Sección: Patrones de carga — usa los del modelo canónico */}
            {isValidated && modelGeometry && modelGeometry.load_patterns.length > 0 && (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">Patrones de carga</h2>
                  <p className="text-xs text-text-muted mt-0.5">
                    Indica cuál patrón corresponde a carga muerta y cuál a carga viva
                  </p>
                </CardHeader>
                <CardBody>
                  <LoadPatternSelector
                    patterns={modelGeometry.load_patterns}
                    cmLoad={project.parameters_json?.cm_load ?? "DEAD"}
                    cvLoad={project.parameters_json?.cv_load ?? "LIVE"}
                    onSave={handleSaveLoadPatterns}
                  />
                </CardBody>
              </Card>
            )}

            {/* Sección: Vista previa del modelo 3D */}
            {isValidated && (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">Modelo estructural 3D</h2>
                  <p className="text-xs text-text-muted mt-0.5">
                    Vista del modelo importado — columnas, vigas y apoyos
                  </p>
                </CardHeader>
                <CardBody>
                  {loadingGeometry ? (
                    <div className="flex items-center justify-center h-48">
                      <p className="text-sm text-text-muted animate-pulse">Cargando modelo 3D...</p>
                    </div>
                  ) : modelGeometry ? (
                    <LinearModelViewer3D geometry={modelGeometry} />
                  ) : (
                    <div className="rounded-lg border border-border bg-surface-2 flex items-center justify-center h-48">
                      <p className="text-sm text-text-muted">
                        Modelo 3D no disponible
                      </p>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}
          </div>
        )}

        {/* ── Tab: Análisis Sísmico ─────────────────────────────────────────── */}
        {activeTab === "seismic" && (
          <div className="flex flex-col gap-6">

            {!isValidated ? (
              <Card>
                <CardBody className="py-12 text-center">
                  <p className="text-text-muted text-sm">
                    Valida el modelo en la pestaña <strong>Modelo</strong> antes de configurar el análisis sísmico.
                  </p>
                  <Button className="mt-4" variant="secondary" onClick={() => setActiveTab("model")}>
                    Ir a Modelo
                  </Button>
                </CardBody>
              </Card>
            ) : (
              <>
                {/* Parámetros sísmicos — placeholder para F3 */}
                {/* Parámetros sísmicos NSR-10 */}
                <Card>
                  <CardHeader>
                    <h2 className="text-sm font-semibold text-text">Parámetros sísmicos NSR-10</h2>
                    <p className="text-xs text-text-muted mt-0.5">
                      Municipio, suelo, sistema estructural y parámetros de análisis
                    </p>
                  </CardHeader>
                  <CardBody>
                    <SeismicParamsForm
                      projectId={project.id}
                      initial={project.parameters_json ?? undefined}
                      onSaved={handleParamsSaved}
                      onPreview={handleSpectrumPreview}
                    />
                  </CardBody>
                </Card>

                {/* Espectro de diseño */}
                {(spectrumData || spectrumLoading) && (
                  <Card>
                    <CardHeader>
                      <h2 className="text-sm font-semibold text-text">Espectro de diseño NSR-10</h2>
                      <p className="text-xs text-text-muted mt-0.5">
                        Sa(T) — espectro elástico reducido por factor R
                      </p>
                    </CardHeader>
                    <CardBody>
                      {spectrumLoading ? (
                        <SpectrumPreview data={null as unknown as SpectrumPreviewResult} loading />
                      ) : spectrumData ? (
                        <SpectrumPreview data={spectrumData} />
                      ) : null}
                    </CardBody>
                  </Card>
                )}

                {/* Análisis modal */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-text">Análisis Modal</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                          Períodos, modos de vibración y participación de masas
                        </p>
                      </div>
                      <Button
                        onClick={() => handleLaunch("modal")}
                        disabled={!isValidated || activeJobTypes.has("modal") || !!launching}
                      >
                        {activeJobTypes.has("modal") ? "Calculando..." : hasModal ? "Recalcular" : "Ejecutar modal"}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardBody>
                    {lastJobByType("modal")?.status === "failed" && (
                      <div className="mb-4 rounded-lg border border-[var(--color-danger)] bg-surface-2 p-3">
                        <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en el análisis modal</p>
                        <pre className="text-[11px] text-text-muted whitespace-pre-wrap line-clamp-6">
                          {lastJobByType("modal")?.error_message}
                        </pre>
                      </div>
                    )}
                    {(lastJobByType("modal")?.status === "pending" || lastJobByType("modal")?.status === "running") && (
                      <div className="rounded-lg border border-border bg-surface-2 p-6 text-center mb-4">
                        <p className="text-sm text-text-muted animate-pulse">Calculando modos de vibración…</p>
                      </div>
                    )}
                    {hasModal && modalResult ? (
                      <ModalResultsTable result={modalResult} />
                    ) : !hasModal && lastJobByType("modal")?.status !== "failed" &&
                        lastJobByType("modal")?.status !== "running" &&
                        lastJobByType("modal")?.status !== "pending" ? (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center">
                        <p className="text-sm text-text-muted">
                          Configura los parámetros sísmicos y ejecuta el análisis modal
                        </p>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>

                {/* Análisis espectral + FHE */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-text">Análisis Espectral RSA + Ajuste FHE</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                          Cortante basal, derivas y verificación NSR-10
                        </p>
                      </div>
                      <Button
                        onClick={() => handleLaunch("spectral")}
                        disabled={!hasModal || !project.parameters_json || activeJobTypes.has("spectral") || !!launching}
                        title={!hasModal ? "Ejecuta el análisis modal primero" : !project.parameters_json ? "Configura los parámetros sísmicos primero" : undefined}
                      >
                        {activeJobTypes.has("spectral") ? "Calculando..." : hasSpectral ? "Recalcular" : "Ejecutar espectral"}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardBody>
                    {lastJobByType("spectral")?.status === "failed" && (
                      <div className="mb-4 rounded-lg border border-[var(--color-danger)] bg-surface-2 p-3">
                        <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en el análisis espectral</p>
                        <pre className="text-[11px] text-text-muted whitespace-pre-wrap line-clamp-6">
                          {lastJobByType("spectral")?.error_message}
                        </pre>
                      </div>
                    )}
                    {(lastJobByType("spectral")?.status === "pending" || lastJobByType("spectral")?.status === "running") && (
                      <div className="rounded-lg border border-border bg-surface-2 p-6 text-center mb-4">
                        <p className="text-sm text-text-muted animate-pulse">Calculando análisis espectral RSA…</p>
                      </div>
                    )}
                    {hasSpectral && spectralResult ? (
                      <SpectralResultsPanel result={spectralResult} />
                    ) : !hasSpectral && lastJobByType("spectral")?.status !== "failed" &&
                        lastJobByType("spectral")?.status !== "running" &&
                        lastJobByType("spectral")?.status !== "pending" ? (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center">
                        <p className="text-sm text-text-muted">
                          {!hasModal
                            ? "Ejecuta el análisis modal primero"
                            : !project.parameters_json
                            ? "Configura los parámetros sísmicos y guárdalos"
                            : "Ejecuta el análisis espectral RSA"}
                        </p>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </>
            )}
          </div>
        )}

        {/* ── Tabs bloqueados ────────────────────────────────────────────────── */}
        {(activeTab === "design" || activeTab === "nonlinear") && (
          <Card>
            <CardBody className="py-16 text-center">
              <p className="text-2xl mb-3">🔒</p>
              <p className="text-text font-medium">Próximamente</p>
              <p className="text-sm text-text-muted mt-2 max-w-sm mx-auto">
                {activeTab === "design"
                  ? "El módulo de diseño de elementos (columnas, vigas, muros) estará disponible una vez completado el análisis sísmico."
                  : "La exportación del modelo no lineal (con refuerzo verificado) hacia el Módulo 3 estará disponible después del diseño."}
              </p>
            </CardBody>
          </Card>
        )}

        {/* ── Historial de jobs (pie de página) ─────────────────────────────── */}
        {jobs.length > 0 && (
          <div className="mt-10">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
              Historial de análisis
            </h3>
            <div className="flex flex-col gap-2">
              {jobs.slice(0, 8).map((j) => (
                <div
                  key={j.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-2.5 text-xs"
                >
                  <div className="flex items-center gap-3">
                    <JobStatusBadge status={j.status} />
                    <span className="text-text capitalize">
                      {{
                        import_validate: "Importar y Validar",
                        modal:           "Análisis Modal",
                        spectral:        "Análisis Espectral",
                      }[j.analysis_type]}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-text-muted">
                      {new Date(j.created_at).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                    {(j.status === "pending" || j.status === "running") && (
                      <Button
                        variant="ghost"
                        onClick={() => handleCancel(j.id)}
                        className="text-xs py-0.5 px-2 h-auto"
                      >
                        Cancelar
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
