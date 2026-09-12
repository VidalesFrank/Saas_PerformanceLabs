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
import ModelEditorPanel from "@/components/linear/ModelEditorPanel";
import { SeismicParamsForm } from "@/components/linear/SeismicParamsForm";
import { SpectrumPreview } from "@/components/linear/SpectrumPreview";
import { ModalResultsTable } from "@/components/linear/ModalResultsTable";
import { SpectralResultsPanel } from "@/components/linear/SpectralResultsPanel";
import { CombinationSelector } from "@/components/linear/CombinationSelector";
import FrameNavigator from "@/components/linear/FrameNavigator";
import ColumnDetailPanel from "@/components/linear/ColumnDetailPanel";
import BeamDetailPanel from "@/components/linear/BeamDetailPanel";
import WallsPanel from "@/components/linear/WallsPanel";
import WallDemandsPanel from "@/components/linear/WallDemandsPanel";
import WallDesignPanel    from "@/components/linear/WallDesignPanel";
import NLPushoverPanel   from "@/components/linear/NLPushoverPanel";
import ModelMaterialsPanel from "@/components/linear/ModelMaterialsPanel";
import ModelSectionsPanel from "@/components/linear/ModelSectionsPanel";
import { NonlinearSpecPanel } from "@/components/linear/NonlinearSpecPanel";
import { ApiError } from "@/lib/api";
import { structuralProjectsApi, structuralAnalysisApi, structuralDesignApi, structuralEditorApi } from "@/lib/structural-api";
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
  ColumnDesignResult,
  BeamDesignResult,
  FrameListResult,
  ColumnDesignDetail,
  BeamDesignDetail,
  FullModelData,
  WallDemandsResult,
  WallDesignResult,
  NLPushoverResult,
} from "@/lib/structural-types";
import { useRequireAuth } from "@/lib/use-require-auth";

// ── Tipos de sección (sidebar) ────────────────────────────────────────────────

type SectionId =
  | "archivos"
  | "vista-3d"
  | "materiales"
  | "secciones"
  | "muros"
  | "sismico"
  | "wall-demands"
  | "wall-design"
  | "nl-pushover"
  | "diseno"
  | "no-lineal";

interface NavItem {
  id: SectionId;
  label: string;
  locked?: boolean;
  lockReason?: string;
}

interface NavGroup {
  groupLabel: string;
  items: NavItem[];
}

function buildNav(hasSpectral: boolean, isValidated: boolean): NavGroup[] {
  return [
    {
      groupLabel: "Modelo",
      items: [
        { id: "archivos",  label: "Archivos y Validación" },
        { id: "vista-3d",  label: "Vista 3D / Editor",   locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
      ],
    },
    {
      groupLabel: "Definir",
      items: [
        { id: "materiales", label: "Materiales", locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
        { id: "secciones",  label: "Secciones",  locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
      ],
    },
    {
      groupLabel: "Asignar",
      items: [
        { id: "muros", label: "Muros", locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
      ],
    },
    {
      groupLabel: "Análisis",
      items: [
        { id: "sismico", label: "Sísmico + Modal + Espectral", locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
        { id: "wall-demands",  label: "Demandas Muros",          locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
        { id: "wall-design",   label: "Diseño Muros RC",          locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
        { id: "nl-pushover",   label: "Pushover No Lineal",       locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
      ],
    },
    {
      groupLabel: "Diseño",
      items: [
        { id: "diseno", label: "Columnas + Vigas", locked: !hasSpectral, lockReason: !hasSpectral ? "Requiere análisis espectral" : undefined },
      ],
    },
    {
      groupLabel: "No Lineal",
      items: [
        { id: "no-lineal", label: "Exportar a Módulo 3", locked: !isValidated, lockReason: !isValidated ? "Requiere modelo validado" : undefined },
      ],
    },
  ];
}

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

const JOB_TYPE_LABEL: Record<string, string> = {
  import_validate: "Validando",
  modal:           "Modal",
  spectral:        "Espectral",
  design_columns:  "Diseño columnas",
  design_beams:    "Diseño vigas",
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

  const [project, setProject]           = useState<StructuralProject | null>(null);
  const [jobs, setJobs]                 = useState<StructuralJob[]>([]);
  const [activeSection, setActiveSection] = useState<SectionId>("archivos");
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);

  // Estado de subida de archivo
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [dragOverXlsx, setDragOverXlsx] = useState(false);
  const [dragOverE2k, setDragOverE2k]   = useState(false);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const e2kFileRef   = useRef<HTMLInputElement>(null);

  // Geometría del modelo 3D
  const [modelGeometry, setModelGeometry]     = useState<ModelGeometry | null>(null);
  const [loadingGeometry, setLoadingGeometry] = useState(false);

  // Estado de lanzamiento de job
  const [launching, setLaunching] = useState<string | null>(null);

  // Resultado de validación cargado
  const [validationResult, setValidationResult]     = useState<ValidationResult | null>(null);
  const [loadingValidation, setLoadingValidation]   = useState(false);

  // Espectro NSR-10 para previsualización
  const [spectrumData, setSpectrumData]       = useState<SpectrumPreviewResult | null>(null);
  const [spectrumLoading, setSpectrumLoading] = useState(false);

  // Resultado del análisis modal
  const [modalResult, setModalResult]       = useState<ModalResult | null>(null);

  // Resultado del análisis espectral
  const [spectralResult, setSpectralResult] = useState<SpectralResult | null>(null);

  // Resultado del diseño de columnas
  const [columnDesignResult, setColumnDesignResult] = useState<ColumnDesignResult | null>(null);

  // Resultado del diseño de vigas
  const [beamDesignResult, setBeamDesignResult] = useState<BeamDesignResult | null>(null);

  // Frame navigator + panel de detalle
  const [frameListData,      setFrameListData]     = useState<FrameListResult | null>(null);
  const [selectedFrameId,    setSelectedFrameId]   = useState<string | null>(null);
  const [selectedFrameType,  setSelectedFrameType] = useState<"column" | "beam" | null>(null);
  const [frameDetailData,    setFrameDetailData]   = useState<ColumnDesignDetail | BeamDesignDetail | null>(null);
  const [loadingFrameDetail, setLoadingFrameDetail] = useState(false);

  // Resultado demandas de muros FHE
  const [wallDemandsResult, setWallDemandsResult] = useState<WallDemandsResult | null>(null);

  // Resultado diseño de muros RC
  const [wallDesignResult, setWallDesignResult] = useState<WallDesignResult | null>(null);

  // Resultado pushover no lineal
  const [nlPushoverResult, setNlPushoverResult] = useState<NLPushoverResult | null>(null);

  // Modelo completo para el panel de Muros (carga lazy al entrar al tab)
  const [fullModelData, setFullModelData] = useState<FullModelData | null>(null);

  // Carga lazy de fullModelData: Muros, Materiales y Secciones lo necesitan
  useEffect(() => {
    const needsModel = activeSection === "muros" || activeSection === "materiales" || activeSection === "secciones";
    if (needsModel && !fullModelData && project?.canonical_model_path) {
      structuralEditorApi.modelData(project.id).then(setFullModelData).catch(() => {});
    }
  }, [activeSection, fullModelData, project]);

  function handleModelDataChange() {
    if (project) {
      structuralEditorApi.modelData(project.id).then(setFullModelData).catch(() => {});
    }
  }

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

  // Cargar resultado de diseño de columnas cuando hay un job exitoso
  const loadColumnDesignResult = useCallback(async (jobList: StructuralJob[]) => {
    const designJob = jobList.find((j) => j.analysis_type === "design_columns" && j.status === "success");
    if (!designJob) return;
    try {
      const result = await structuralAnalysisApi.result<ColumnDesignResult>(designJob.id);
      setColumnDesignResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar resultado de diseño de vigas cuando hay un job exitoso
  const loadBeamDesignResult = useCallback(async (jobList: StructuralJob[]) => {
    const beamJob = jobList.find((j) => j.analysis_type === "design_beams" && j.status === "success");
    if (!beamJob) return;
    try {
      const result = await structuralAnalysisApi.result<BeamDesignResult>(beamJob.id);
      setBeamDesignResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar resultado de demandas de muros FHE cuando hay un job exitoso
  const loadWallDemandsResult = useCallback(async (jobList: StructuralJob[]) => {
    const wallJob = jobList.find((j) => j.analysis_type === "wall_demands" && j.status === "success");
    if (!wallJob) return;
    try {
      const result = await structuralAnalysisApi.result<WallDemandsResult>(wallJob.id);
      setWallDemandsResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar resultado de diseño de muros RC cuando hay un job exitoso
  const loadWallDesignResult = useCallback(async (jobList: StructuralJob[]) => {
    const designJob = jobList.find((j) => j.analysis_type === "wall_design" && j.status === "success");
    if (!designJob) return;
    try {
      const result = await structuralAnalysisApi.result<WallDesignResult>(designJob.id);
      setWallDesignResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar resultado de pushover no lineal cuando hay un job exitoso
  const loadNLPushoverResult = useCallback(async (jobList: StructuralJob[]) => {
    const pushJob = jobList.find((j) => j.analysis_type === "nl_pushover" && j.status === "success");
    if (!pushJob) return;
    try {
      const result = await structuralAnalysisApi.result<NLPushoverResult>(pushJob.id);
      setNlPushoverResult(result);
    } catch { /* silencioso */ }
  }, []);

  // Cargar lista de frames para el navigator
  const loadFrameList = useCallback(async () => {
    try {
      const list = await structuralDesignApi.listFrames(params.id);
      setFrameListData(list);
    } catch { /* silencioso */ }
  }, [params.id]);

  // Cargar detalle de un frame concreto
  const loadFrameDetail = useCallback(async (frameId: string) => {
    setLoadingFrameDetail(true);
    setFrameDetailData(null);
    try {
      const detail = await structuralDesignApi.getFrame(params.id, frameId);
      setFrameDetailData(detail);
    } catch { /* silencioso */ } finally {
      setLoadingFrameDetail(false);
    }
  }, [params.id]);

  // Polling mientras haya jobs activos
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === "pending" || j.status === "running");
    const hasAnyDesign = jobs.some(
      (j) => (j.analysis_type === "design_columns" || j.analysis_type === "design_beams") && j.status === "success"
    );
    if (!hasActive) {
      if (pollRef.current) clearInterval(pollRef.current);
      if (!validationResult)    loadValidationResult(jobs);
      if (!modalResult)         loadModalResult(jobs);
      if (!spectralResult)      loadSpectralResult(jobs);
      if (!columnDesignResult)  loadColumnDesignResult(jobs);
      if (!beamDesignResult)    loadBeamDesignResult(jobs);
      if (!wallDemandsResult)   loadWallDemandsResult(jobs);
      if (!wallDesignResult)    loadWallDesignResult(jobs);
      if (!nlPushoverResult)    loadNLPushoverResult(jobs);
      if (!frameListData && hasAnyDesign) loadFrameList();
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
        if (!validationResult)    loadValidationResult(jobList);
        if (!modalResult)         loadModalResult(jobList);
        if (!spectralResult)      loadSpectralResult(jobList);
        if (!columnDesignResult)  loadColumnDesignResult(jobList);
        if (!beamDesignResult)    loadBeamDesignResult(jobList);
        if (!wallDemandsResult)   loadWallDemandsResult(jobList);
        if (!wallDesignResult)    loadWallDesignResult(jobList);
        if (!nlPushoverResult)    loadNLPushoverResult(jobList);
        if (!modelGeometry && proj.canonical_model_path) loadModelGeometry(proj);
        // Recargar frame list cuando un job de diseño acaba de completarse
        const nowHasDesign = jobList.some(
          (j) => (j.analysis_type === "design_columns" || j.analysis_type === "design_beams") && j.status === "success"
        );
        if (nowHasDesign && !frameListData) loadFrameList();
      } catch {
        // silencioso en polling
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobs, params.id, validationResult, modalResult, spectralResult, columnDesignResult,
      beamDesignResult, wallDemandsResult, wallDesignResult, nlPushoverResult, frameListData,
      modelGeometry, loadValidationResult, loadModalResult, loadSpectralResult,
      loadColumnDesignResult, loadBeamDesignResult, loadWallDemandsResult, loadWallDesignResult,
      loadNLPushoverResult, loadFrameList, loadModelGeometry]);

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

  async function handleLaunch(analysisType: "import_validate" | "modal" | "spectral" | "design_columns" | "design_beams" | "wall_demands" | "wall_design" | "nl_pushover") {
    if (!project) return;
    setLaunching(analysisType);
    if (analysisType === "design_columns" || analysisType === "design_beams") {
      setFrameListData(null);
      setSelectedFrameId(null);
      setSelectedFrameType(null);
      setFrameDetailData(null);
    }
    try {
      const job = await structuralAnalysisApi.launch(project.id, analysisType);
      setJobs((prev) => [job, ...prev]);
      // Primer poll rápido a 1.5 s para capturar jobs que terminan en segundos
      setTimeout(async () => {
        try {
          const [proj, jobList] = await Promise.all([
            structuralProjectsApi.get(params.id),
            structuralProjectsApi.jobs(params.id),
          ]);
          setProject(proj);
          setJobs(jobList);
          if (!validationResult)   loadValidationResult(jobList);
          if (!modalResult)        loadModalResult(jobList);
          if (!spectralResult)     loadSpectralResult(jobList);
          if (!columnDesignResult) loadColumnDesignResult(jobList);
          if (!beamDesignResult)   loadBeamDesignResult(jobList);
          if (!modelGeometry && proj.canonical_model_path) loadModelGeometry(proj);
        } catch { /* silencioso */ }
      }, 1500);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al lanzar el análisis");
    } finally {
      setLaunching(null);
    }
  }

  function handleFrameSelect(frameId: string, elementType: "column" | "beam") {
    setSelectedFrameId(frameId);
    setSelectedFrameType(elementType);
    loadFrameDetail(frameId);
  }

  async function handleReinforcementSaved() {
    await loadFrameList();
    if (selectedFrameId) loadFrameDetail(selectedFrameId);
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

  function handleParamsSaved(p: SeismicParameters) {
    setProject((prev) => prev ? { ...prev, parameters_json: p } : prev);
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
  const isEditorMode   = activeSection === "vista-3d" && isValidated && !!modelGeometry;
  const hasModal       = jobs.some((j) => j.analysis_type === "modal"   && j.status === "success");
  const hasSpectral    = jobs.some((j) => j.analysis_type === "spectral" && j.status === "success");
  const hasDesign      = jobs.some((j) => j.analysis_type === "design_columns" && j.status === "success");
  const hasBeamDesign  = jobs.some((j) => j.analysis_type === "design_beams"   && j.status === "success");
  const hasWallDemands = jobs.some((j) => j.analysis_type === "wall_demands" && j.status === "success");
  const hasWallDesign  = jobs.some((j) => j.analysis_type === "wall_design"  && j.status === "success");
  const hasNLPushover  = jobs.some((j) => j.analysis_type === "nl_pushover"  && j.status === "success");
  const activeJobTypes = new Set(
    jobs.filter((j) => j.status === "pending" || j.status === "running").map((j) => j.analysis_type)
  );

  const lastJobByType = (type: string) =>
    jobs.find((j) => j.analysis_type === type);

  if (!ready) return null;

  // ── Sidebar component ──────────────────────────────────────────────────────

  function Sidebar({ projectName, validationStatus }: { projectName?: string; validationStatus?: ValidationStatus }) {
    const vInfo = validationStatus ? VALIDATION_INFO[validationStatus] : null;
    const navGroups = buildNav(hasSpectral, isValidated);
    const activeJobs = jobs.filter((j) => j.status === "pending" || j.status === "running");

    return (
      <aside className="w-56 flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
        {/* Project name + validation status */}
        <div className="px-3 pt-4 pb-3 border-b border-[var(--border)] flex-shrink-0">
          <p className="text-xs font-semibold text-[var(--text)] truncate leading-tight">
            {projectName ?? "Proyecto"}
          </p>
          {vInfo && (
            <div className="flex items-center gap-1.5 mt-1">
              <div
                className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                style={{ background: vInfo.color }}
              />
              <span className="text-[10px]" style={{ color: vInfo.color }}>{vInfo.label}</span>
            </div>
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto py-1">
          {navGroups.map((group) => (
            <div key={group.groupLabel}>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] px-3 pt-4 pb-1">
                {group.groupLabel}
              </p>
              {group.items.map((item) => {
                const isActive = activeSection === item.id;
                const isLocked = item.locked;
                return (
                  <button
                    key={item.id}
                    onClick={() => !isLocked && setActiveSection(item.id)}
                    title={isLocked ? item.lockReason : undefined}
                    className={[
                      "w-full text-left text-xs px-3 py-1.5 rounded-lg mx-0 transition-colors flex items-center gap-1.5",
                      isLocked
                        ? "opacity-40 cursor-not-allowed text-[var(--text-muted)]"
                        : isActive
                        ? "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)] font-medium border-l-2 border-[var(--accent)] pl-[10px]"
                        : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                    ].join(" ")}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Active jobs indicator */}
        {activeJobs.length > 0 && (
          <div className="border-t border-[var(--border)] py-2 flex-shrink-0">
            {activeJobs.map((j) => (
              <div key={j.id} className="text-[10px] px-3 py-1 text-[var(--accent)] animate-pulse flex items-center gap-1">
                <span>↻</span>
                <span>{JOB_TYPE_LABEL[j.analysis_type] ?? j.analysis_type}</span>
              </div>
            ))}
          </div>
        )}
      </aside>
    );
  }

  // ── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        <AppHeader crumb="Constructor de Modelos" />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <aside className="w-56 flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface)]">
            <div className="px-3 pt-4 pb-3">
              <p className="text-xs text-[var(--text-muted)]">Cargando...</p>
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-10">
              <p className="text-sm text-[var(--text-muted)]">Cargando proyecto...</p>
            </div>
          </main>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (error || !project) {
    return (
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        <AppHeader crumb="Constructor de Modelos" />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <aside className="w-56 flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface)]">
            <div className="px-3 pt-4 pb-3">
              <p className="text-xs text-[var(--text-muted)]">Error</p>
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-10">
              <p className="text-sm text-[var(--danger)]">{error ?? "Proyecto no encontrado"}</p>
              <Button className="mt-4" variant="ghost" onClick={() => router.push("/projects")}>
                ← Volver a proyectos
              </Button>
            </div>
          </main>
        </div>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <AppHeader crumb="Constructor de Modelos" />
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* LEFT SIDEBAR */}
        <Sidebar projectName={project.name} validationStatus={project.validation_status} />

        {/* MAIN CONTENT */}
        <main className={
          activeSection === "vista-3d" && isEditorMode
            ? "flex-1 min-h-0 overflow-hidden flex flex-col"
            : "flex-1 overflow-y-auto"
        }>

          {/* ── Vista 3D / Editor ───────────────────────────────────────────── */}
          {activeSection === "vista-3d" && isEditorMode && (
            <ModelEditorPanel
              projectId={project.id}
              geometry={modelGeometry!}
              onLaunchAnalysis={(type) => {
                setActiveSection("sismico");
                handleLaunch(type as "modal" | "spectral");
              }}
              analysisRunning={activeJobTypes.has("modal") || activeJobTypes.has("spectral")}
            />
          )}

          {activeSection === "vista-3d" && !isEditorMode && (
            <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col gap-6">
              <div className="mb-4">
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-2">
                  <Link href="/projects" className="hover:text-[var(--accent)] transition-colors">Proyectos</Link>
                  <span>/</span>
                  <span className="text-[var(--text)]">{project.name}</span>
                </div>
                <h1 className="text-xl font-semibold text-[var(--text)]">Vista 3D / Editor</h1>
              </div>
              <Card>
                <CardBody className="py-12 text-center">
                  <p className="text-[var(--text-muted)] text-sm">
                    {!isValidated
                      ? "El modelo debe estar validado para acceder al editor 3D."
                      : "El modelo 3D no está disponible aún."}
                  </p>
                  <Button className="mt-4" variant="secondary" onClick={() => setActiveSection("archivos")}>
                    Ir a Archivos y Validación
                  </Button>
                </CardBody>
              </Card>
            </div>
          )}

          {/* ── Archivos y Validación ────────────────────────────────────────── */}
          {activeSection === "archivos" && (
            <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col gap-6">

              {/* Breadcrumb + título */}
              <div className="mb-2">
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-2">
                  <Link href="/projects" className="hover:text-[var(--accent)] transition-colors">Proyectos</Link>
                  <span>/</span>
                  <span className="text-[var(--text)]">{project.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-semibold text-[var(--text)]">{project.name}</h1>
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ background: `${VALIDATION_INFO[project.validation_status].color}22`, color: VALIDATION_INFO[project.validation_status].color }}
                  >
                    {VALIDATION_INFO[project.validation_status].label}
                  </span>
                </div>
                {project.description && (
                  <p className="mt-1 text-sm text-[var(--text-muted)]">{project.description}</p>
                )}
              </div>

              {/* Sección: Cargar modelo */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-[var(--text)]">Archivo de modelo</h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
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
                          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
                          : project.input_file_path
                          ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5 hover:border-[var(--color-success)]"
                          : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]",
                      ].join(" ")}
                    >
                      <span className="text-2xl mb-2 select-none">
                        {project.input_file_path ? "✅" : "📊"}
                      </span>
                      <p className="text-sm font-medium text-[var(--text)] text-center">
                        {project.input_file_path ? "Modelo XLSX cargado" : "Modelo ETABS (.xlsx)"}
                      </p>
                      <p className="text-[11px] text-[var(--text-muted)] text-center mt-1">
                        {project.input_file_path
                          ? "Clic o arrastra para reemplazar"
                          : "Arrastra aquí o haz clic para seleccionar"}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-1 opacity-70">
                        File → Export → Excel Spreadsheet
                      </p>
                      {dragOverXlsx && (
                        <div className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] flex items-center justify-center">
                          <p className="text-[var(--accent)] font-semibold text-sm">Suelta para subir</p>
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
                          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
                          : project.e2k_file_path
                          ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5 hover:border-[var(--color-success)]"
                          : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]",
                      ].join(" ")}
                    >
                      <span className="text-2xl mb-2 select-none">
                        {project.e2k_file_path ? "✅" : "📄"}
                      </span>
                      <p className="text-sm font-medium text-[var(--text)] text-center">
                        {project.e2k_file_path ? "Archivo .e2k cargado" : "ETABS Text (.e2k)"}
                      </p>
                      <p className="text-[11px] text-[var(--text-muted)] text-center mt-1">
                        {project.e2k_file_path
                          ? "Clic o arrastra para reemplazar"
                          : "Arrastra aquí o haz clic para seleccionar"}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-1 opacity-70">
                        File → Export → ETABS Text File
                      </p>
                      {dragOverE2k && (
                        <div className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] flex items-center justify-center">
                          <p className="text-[var(--accent)] font-semibold text-sm">Suelta para subir</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {uploadError && (
                    <p className="text-sm text-[var(--danger)]">{uploadError}</p>
                  )}
                  {uploading && (
                    <p className="text-sm text-[var(--text-muted)] animate-pulse">Subiendo archivo...</p>
                  )}
                </CardBody>
              </Card>

              {/* Sección: Validar modelo */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-[var(--text)]">Validación del modelo</h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    Verifica la integridad del modelo antes de ejecutar análisis
                  </p>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">

                  {!hasFile ? (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6 text-center">
                      <p className="text-sm text-[var(--text-muted)]">
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
                            style={{ background: VALIDATION_INFO[project.validation_status].color }}
                          />
                          <span className="text-sm text-[var(--text)]">{VALIDATION_INFO[project.validation_status].label}</span>
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
                            <div className="rounded-lg border border-[var(--danger)] bg-[var(--surface-2)] p-4">
                              <p className="text-xs font-semibold text-[var(--danger)] mb-1">Error en la tarea</p>
                              <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap line-clamp-6">
                                {lastValidation.error_message}
                              </pre>
                            </div>
                          );
                        }

                        if (lastValidation.status === "running" || lastValidation.status === "pending") {
                          return (
                            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
                              <p className="text-sm text-[var(--text-muted)]">Validando el modelo...</p>
                            </div>
                          );
                        }

                        if (lastValidation.status === "success") {
                          if (loadingValidation) {
                            return (
                              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
                                <p className="text-sm text-[var(--text-muted)]">Cargando resultados...</p>
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

              {/* Sección: Patrones de carga */}
              {isValidated && modelGeometry && modelGeometry.load_patterns.length > 0 && (
                <Card>
                  <CardHeader>
                    <h2 className="text-sm font-semibold text-[var(--text)]">Patrones de carga</h2>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
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
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-[var(--text)]">Modelo estructural 3D</h2>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                          Vista del modelo importado — columnas, vigas y apoyos
                        </p>
                      </div>
                      {modelGeometry && (
                        <Button variant="secondary" onClick={() => setActiveSection("vista-3d")}>
                          Abrir editor 3D →
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardBody>
                    {loadingGeometry ? (
                      <div className="flex items-center justify-center h-48">
                        <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando modelo 3D...</p>
                      </div>
                    ) : modelGeometry ? (
                      <LinearModelViewer3D geometry={modelGeometry} />
                    ) : (
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-center h-48">
                        <p className="text-sm text-[var(--text-muted)]">
                          Modelo 3D no disponible
                        </p>
                      </div>
                    )}
                  </CardBody>
                </Card>
              )}

              {/* Historial de jobs */}
              {jobs.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                    Historial de análisis
                  </h3>
                  <div className="flex flex-col gap-2">
                    {jobs.slice(0, 8).map((j) => (
                      <div
                        key={j.id}
                        className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <JobStatusBadge status={j.status} />
                          <span className="text-[var(--text)] capitalize">
                            {{
                              import_validate: "Importar y Validar",
                              modal:           "Análisis Modal",
                              spectral:        "Análisis Espectral",
                              design_columns:  "Verificación P-M Columnas",
                              design_beams:    "Diseño de Vigas",
                              wall_demands:    "Demandas Muros FHE",
                            }[j.analysis_type as string]}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[var(--text-muted)]">
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
            </div>
          )}

          {/* ── Sísmico + Modal + Espectral ──────────────────────────────────── */}
          {activeSection === "sismico" && (
            <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col gap-6">

              {!isValidated ? (
                <Card>
                  <CardBody className="py-12 text-center">
                    <p className="text-[var(--text-muted)] text-sm">
                      Valida el modelo en <strong>Archivos y Validación</strong> antes de configurar el análisis sísmico.
                    </p>
                    <Button className="mt-4" variant="secondary" onClick={() => setActiveSection("archivos")}>
                      Ir a Archivos y Validación
                    </Button>
                  </CardBody>
                </Card>
              ) : (
                <>
                  {/* Parámetros sísmicos NSR-10 */}
                  <Card>
                    <CardHeader>
                      <h2 className="text-sm font-semibold text-[var(--text)]">Parámetros sísmicos NSR-10</h2>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
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
                        <h2 className="text-sm font-semibold text-[var(--text)]">Espectro de diseño NSR-10</h2>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
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
                          <h2 className="text-sm font-semibold text-[var(--text)]">Análisis Modal</h2>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            Períodos, modos de vibración y participación de masas
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => handleLaunch("modal")}
                            disabled={!isValidated || activeJobTypes.has("modal") || !!launching}
                          >
                            {activeJobTypes.has("modal") ? "Calculando..." : hasModal ? "Recalcular" : "Ejecutar modal"}
                          </Button>
                          {activeJobTypes.has("modal") && (() => {
                            const activeJob = jobs.find(j =>
                              j.analysis_type === "modal" && (j.status === "pending" || j.status === "running")
                            );
                            return activeJob ? (
                              <Button variant="secondary" onClick={() => handleCancel(activeJob.id)}>
                                Cancelar
                              </Button>
                            ) : null;
                          })()}
                        </div>
                      </div>
                    </CardHeader>
                    <CardBody>
                      {lastJobByType("modal")?.status === "failed" && (
                        <div className="mb-4 rounded-lg border border-[var(--color-danger)] bg-[var(--surface-2)] p-3">
                          <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en el análisis modal</p>
                          <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap line-clamp-6">
                            {lastJobByType("modal")?.error_message}
                          </pre>
                        </div>
                      )}
                      {(lastJobByType("modal")?.status === "pending" || lastJobByType("modal")?.status === "running") && (
                        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6 text-center mb-4">
                          <p className="text-sm text-[var(--text-muted)] animate-pulse">Calculando modos de vibración…</p>
                        </div>
                      )}
                      {hasModal && modalResult ? (
                        <ModalResultsTable result={modalResult} />
                      ) : !hasModal && lastJobByType("modal")?.status !== "failed" &&
                          lastJobByType("modal")?.status !== "running" &&
                          lastJobByType("modal")?.status !== "pending" ? (
                        <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center">
                          <p className="text-sm text-[var(--text-muted)]">
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
                          <h2 className="text-sm font-semibold text-[var(--text)]">Análisis Espectral RSA + Ajuste FHE</h2>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5">
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
                        <div className="mb-4 rounded-lg border border-[var(--color-danger)] bg-[var(--surface-2)] p-3">
                          <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en el análisis espectral</p>
                          <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap line-clamp-6">
                            {lastJobByType("spectral")?.error_message}
                          </pre>
                        </div>
                      )}
                      {(lastJobByType("spectral")?.status === "pending" || lastJobByType("spectral")?.status === "running") && (
                        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6 text-center mb-4">
                          <p className="text-sm text-[var(--text-muted)] animate-pulse">Calculando análisis espectral RSA…</p>
                        </div>
                      )}
                      {hasSpectral && spectralResult ? (
                        <SpectralResultsPanel result={spectralResult} />
                      ) : !hasSpectral && lastJobByType("spectral")?.status !== "failed" &&
                          lastJobByType("spectral")?.status !== "running" &&
                          lastJobByType("spectral")?.status !== "pending" ? (
                        <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center">
                          <p className="text-sm text-[var(--text-muted)]">
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

          {/* ── Diseño ───────────────────────────────────────────────────────── */}
          {activeSection === "diseno" && hasSpectral && (
            <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col gap-6">

              {/* Combinaciones NSR-10 */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-[var(--text)]">
                    Combinaciones de diseño — NSR-10 Título B
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    Selecciona las combinaciones LRFD a incluir en la envolvente de diseño.
                    Las fuerzas sísmicas E provienen del RSA y ya incorporan el factor R.
                  </p>
                </CardHeader>
                <CardBody>
                  <CombinationSelector
                    projectId={project.id}
                    cmLoad={project.parameters_json?.cm_load ?? "DEAD"}
                    cvLoad={project.parameters_json?.cv_load ?? "LIVE"}
                  />
                </CardBody>
              </Card>

              {/* Botones de lanzamiento — fila compacta */}
              <div className="grid grid-cols-2 gap-4">
                {/* Verificación P-M de columnas */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-[var(--text)]">Verificación P-M columnas</h2>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">Envolvente NSR-10 · Método del pórtico</p>
                      </div>
                      <Button
                        onClick={() => handleLaunch("design_columns")}
                        disabled={activeJobTypes.has("design_columns") || !!launching}
                      >
                        {activeJobTypes.has("design_columns") ? "Calculando..." : hasDesign ? "Recalcular" : "Verificar"}
                      </Button>
                    </div>
                  </CardHeader>
                  {lastJobByType("design_columns")?.status === "failed" && (
                    <CardBody>
                      <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--surface-2)] p-3">
                        <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en la verificación</p>
                        <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap line-clamp-4">
                          {lastJobByType("design_columns")?.error_message}
                        </pre>
                      </div>
                    </CardBody>
                  )}
                  {(lastJobByType("design_columns")?.status === "pending" ||
                    lastJobByType("design_columns")?.status === "running") && (
                    <CardBody>
                      <p className="text-sm text-[var(--text-muted)] animate-pulse py-1">Calculando envolvente de diseño…</p>
                    </CardBody>
                  )}
                </Card>

                {/* Diseño de vigas */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-[var(--text)]">Diseño vigas — Flexión + Cortante</h2>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">ACI 318 / NSR-10 C · As mínimo NSR-10 C.9.6.1</p>
                      </div>
                      <Button
                        onClick={() => handleLaunch("design_beams")}
                        disabled={activeJobTypes.has("design_beams") || !!launching}
                      >
                        {activeJobTypes.has("design_beams") ? "Calculando..." : hasBeamDesign ? "Recalcular" : "Diseñar vigas"}
                      </Button>
                    </div>
                  </CardHeader>
                  {lastJobByType("design_beams")?.status === "failed" && (
                    <CardBody>
                      <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--surface-2)] p-3">
                        <p className="text-xs font-semibold text-[var(--color-danger)] mb-1">Error en el diseño de vigas</p>
                        <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap line-clamp-4">
                          {lastJobByType("design_beams")?.error_message}
                        </pre>
                      </div>
                    </CardBody>
                  )}
                  {(lastJobByType("design_beams")?.status === "pending" ||
                    lastJobByType("design_beams")?.status === "running") && (
                    <CardBody>
                      <p className="text-sm text-[var(--text-muted)] animate-pulse py-1">Calculando diseño de vigas…</p>
                    </CardBody>
                  )}
                </Card>
              </div>

              {/* Navigator de frames + panel de detalle */}
              {frameListData ? (
                <div
                  className="flex border border-[var(--border)] rounded-xl overflow-hidden"
                  style={{ height: "calc(100vh - 380px)", minHeight: "580px" }}
                >
                  {/* Sidebar izquierdo: navegador por piso */}
                  <div className="w-64 flex-shrink-0 overflow-hidden">
                    <FrameNavigator
                      data={frameListData}
                      selectedFrameId={selectedFrameId}
                      onSelect={handleFrameSelect}
                    />
                  </div>

                  {/* Panel derecho: detalle del elemento seleccionado */}
                  <div className="flex-1 overflow-y-auto bg-[var(--background)]">
                    {loadingFrameDetail ? (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-sm text-[var(--muted)] animate-pulse">Cargando detalle…</p>
                      </div>
                    ) : frameDetailData && selectedFrameType === "column" ? (
                      <ColumnDetailPanel
                        projectId={project.id}
                        data={frameDetailData as ColumnDesignDetail}
                        onReinforcementSaved={handleReinforcementSaved}
                      />
                    ) : frameDetailData && selectedFrameType === "beam" ? (
                      <BeamDetailPanel
                        projectId={project.id}
                        data={frameDetailData as BeamDesignDetail}
                        onReinforcementSaved={handleReinforcementSaved}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--muted)]">
                        <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                          <rect x="6" y="6" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3"/>
                          <path d="M16 22h12M22 16v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        <p className="text-sm">Selecciona un elemento del navegador</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (hasDesign || hasBeamDesign) ? (
                <div className="rounded-xl border border-[var(--border)] p-8 text-center">
                  <p className="text-sm text-[var(--muted)] animate-pulse">Cargando navegador de elementos…</p>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
                  <p className="text-sm text-[var(--muted)]">
                    Configura las combinaciones y ejecuta la verificación P-M de columnas o el diseño de vigas
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Materiales ───────────────────────────────────────────────────── */}
          {activeSection === "materiales" && (
            <div className="flex flex-col gap-0 h-full" style={{ minHeight: "500px" }}>
              {fullModelData ? (
                <div className="flex h-full rounded-xl border border-[var(--border)] overflow-hidden m-4">
                  <div className="w-80 flex-shrink-0 border-r border-[var(--border)] overflow-hidden">
                    <ModelMaterialsPanel
                      projectId={project.id}
                      modelData={fullModelData}
                      onModelDataChange={handleModelDataChange}
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto p-6 bg-[var(--surface)]">
                    <div className="max-w-xl">
                      <h3 className="text-sm font-semibold text-[var(--text)] mb-1">Modelos constitutivos</h3>
                      <p className="text-xs text-[var(--text-muted)] mb-4">
                        Haz clic en un material de la lista para ver su curva tensión-deformación.
                        Concreto: modelo parabólico de Mander. Acero: bilineal elástico-perfecto.
                      </p>
                      <div className="rounded-lg border border-[var(--border)]/50 bg-[var(--surface-2)] divide-y divide-[var(--border)]/30">
                        <div className="px-4 py-3">
                          <p className="text-[11px] font-semibold text-[var(--text)] mb-0.5">Concreto — Modelo de Mander</p>
                          <p className="text-[10px] text-[var(--text-muted)]">
                            fc = f&apos;c · (2x − x²) donde x = ε/ε₀, ε₀ = 2f&apos;c/Ec.
                            Rama descendente lineal hasta 0.2f&apos;c en εcu = 0.003 (no confinado).
                          </p>
                        </div>
                        <div className="px-4 py-3">
                          <p className="text-[11px] font-semibold text-[var(--text)] mb-0.5">Acero — Bilineal elástico-perfecto</p>
                          <p className="text-[10px] text-[var(--text-muted)]">
                            σ = E·ε para ε &lt; εy = fy/E; σ = fy para ε ≥ εy.
                            E = 200 GPa por defecto (acero estructural NSR-10).
                          </p>
                        </div>
                        <div className="px-4 py-3">
                          <p className="text-[11px] font-semibold text-[var(--text)] mb-0.5">En el modelo no lineal (OpenSees)</p>
                          <p className="text-[10px] text-[var(--text-muted)]">
                            Estos parámetros se usan para definir Concrete02 y Steel02 en el
                            generador de modelos MVLEM/SFI. Las fibras de la sección toman la
                            curva completa ciclo a ciclo.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center flex-1">
                  <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando materiales...</p>
                </div>
              )}
            </div>
          )}

          {/* ── Secciones ────────────────────────────────────────────────────── */}
          {activeSection === "secciones" && (
            <div className="flex flex-col gap-0 h-full" style={{ minHeight: "500px" }}>
              {fullModelData ? (
                <div className="flex h-full rounded-xl border border-[var(--border)] overflow-hidden m-4">
                  <div className="w-80 flex-shrink-0 border-r border-[var(--border)] overflow-hidden">
                    <ModelSectionsPanel
                      projectId={project.id}
                      modelData={fullModelData}
                      onModelDataChange={handleModelDataChange}
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto p-6 bg-[var(--surface)]">
                    <div className="max-w-xl">
                      <h3 className="text-sm font-semibold text-[var(--text)] mb-1">Secciones transversales</h3>
                      <p className="text-xs text-[var(--text-muted)] mb-4">
                        Haz clic en &quot;Editar&quot; para ver el preview gráfico de la sección con
                        sus propiedades geométricas calculadas.
                      </p>
                      <div className="rounded-lg border border-[var(--border)]/50 bg-[var(--surface-2)] divide-y divide-[var(--border)]/30">
                        {Object.entries(fullModelData.sections).slice(0, 8).map(([name, sec]) => {
                          const h_cm = sec.h_m * 100;
                          const b_cm = sec.b_m * 100;
                          const A    = sec.b_m * sec.h_m;
                          const I33  = sec.b_m * sec.h_m ** 3 / 12;
                          return (
                            <div key={name} className="flex items-center gap-4 px-4 py-2.5">
                              <svg width={36} height={28} viewBox="0 0 36 28">
                                {(() => {
                                  const maxD = Math.max(h_cm, b_cm, 1);
                                  const s = 22 / maxD;
                                  const rw = Math.max(b_cm * s, 2);
                                  const rh = Math.max(h_cm * s, 2);
                                  return (
                                    <rect x={(36 - rw) / 2} y={(28 - rh) / 2}
                                      width={rw} height={rh}
                                      fill="#6366F1" fillOpacity="0.15"
                                      stroke="#6366F1" strokeWidth="1" />
                                  );
                                })()}
                              </svg>
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold text-[var(--text)] truncate">{name}</p>
                                <p className="text-[10px] text-[var(--text-muted)]">
                                  {h_cm.toFixed(0)}×{b_cm.toFixed(0)} cm · {sec.material}
                                </p>
                              </div>
                              <div className="text-right text-[10px] text-[var(--text-muted)]">
                                <p>A = <span className="font-mono text-[var(--text)]">{(A * 1e4).toFixed(0)} cm²</span></p>
                                <p>I₃₃ = <span className="font-mono text-[var(--text)]">{(I33 * 1e8).toFixed(0)} cm⁴</span></p>
                              </div>
                            </div>
                          );
                        })}
                        {Object.keys(fullModelData.sections).length > 8 && (
                          <p className="px-4 py-2 text-[10px] text-[var(--text-muted)]">
                            … y {Object.keys(fullModelData.sections).length - 8} secciones más en la lista
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center flex-1">
                  <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando secciones...</p>
                </div>
              )}
            </div>
          )}

          {/* ── Muros ────────────────────────────────────────────────────────── */}
          {activeSection === "muros" && (
            <div className="flex flex-col gap-0 h-full" style={{ minHeight: "500px" }}>
              {fullModelData ? (
                <WallsPanel
                  projectId={project.id}
                  materials={Object.keys(fullModelData.materials)}
                  steelTypes={["G420", "G60", "PDR60", "A60", "A615Gr60"]}
                />
              ) : (
                <div className="flex items-center justify-center flex-1">
                  <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando modelo...</p>
                </div>
              )}
            </div>
          )}

          {/* ── Demandas Muros FHE ───────────────────────────────────────────── */}
          {activeSection === "wall-demands" && (
            <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col gap-6">
              <div>
                <h1 className="text-xl font-semibold text-[var(--text)]">Demandas de Muros — FHE NSR-10</h1>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  Modelo MVLEM_3D elástico · FHE NSR-10 A.4.2 · Combinaciones C.9.2.1
                </p>
              </div>

              {/* Launch card */}
              <Card>
                <CardBody className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">Análisis FHE + combinaciones NSR-10</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      Construye el modelo MVLEM_3D, aplica fuerzas horizontales equivalentes por piso
                      y genera la envolvente de diseño (Pu, Vu, Mu) por pier por historia.
                    </p>
                  </div>
                  <Button
                    disabled={activeJobTypes.has("wall_demands") || !project?.parameters_json}
                    onClick={() => handleLaunch("wall_demands")}
                    title={!project?.parameters_json ? "Configura los parámetros sísmicos NSR-10 primero" : undefined}
                  >
                    {activeJobTypes.has("wall_demands") ? "Calculando..." : hasWallDemands ? "Recalcular" : "Calcular"}
                  </Button>
                </CardBody>
              </Card>

              {/* Results */}
              {hasWallDemands && wallDemandsResult && (
                <WallDemandsPanel result={wallDemandsResult} />
              )}

              {/* Running indicator */}
              {activeJobTypes.has("wall_demands") && !hasWallDemands && (
                <Card>
                  <CardBody>
                    <p className="text-sm text-[var(--text-muted)] animate-pulse">
                      Construyendo modelo y calculando demandas...
                    </p>
                  </CardBody>
                </Card>
              )}

              {/* Last job status */}
              {lastJobByType("wall_demands") && (
                <JobStatusBadge status={lastJobByType("wall_demands")!.status} />
              )}
            </div>
          )}

          {/* ── Diseño Muros RC ──────────────────────────────────────────────── */}
          {activeSection === "wall-design" && (
            <div className="mx-auto max-w-6xl px-6 py-8 flex flex-col gap-6">
              <div>
                <h1 className="text-xl font-semibold text-[var(--text)]">Diseño de Muros RC — NSR-10 C.21</h1>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  Auto-diseño por pier · P-M interacción · EBE · Cortante ACI 318-25 · 9 verificaciones NSR-10
                </p>
              </div>

              <Card>
                <CardBody className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">Diseño completo por pier/piso</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      Requiere demandas de muros calculadas. Usa fuerzas RSA del espectral si están disponibles.
                      Produce refuerzo ρ_l, ρ_t, EBE y confinamiento por cada pier de cada piso.
                    </p>
                  </div>
                  <Button
                    disabled={activeJobTypes.has("wall_design") || !hasWallDemands}
                    onClick={() => handleLaunch("wall_design")}
                    title={!hasWallDemands ? "Ejecuta primero el análisis de demandas de muros" : undefined}
                  >
                    {activeJobTypes.has("wall_design") ? "Diseñando..." : hasWallDesign ? "Recalcular" : "Diseñar"}
                  </Button>
                </CardBody>
              </Card>

              {hasWallDesign && wallDesignResult && (
                <WallDesignPanel result={wallDesignResult} />
              )}

              {activeJobTypes.has("wall_design") && !hasWallDesign && (
                <Card>
                  <CardBody>
                    <p className="text-sm text-[var(--text-muted)] animate-pulse">
                      Calculando diseño de muros por pier...
                    </p>
                  </CardBody>
                </Card>
              )}

              {lastJobByType("wall_design") && (
                <JobStatusBadge status={lastJobByType("wall_design")!.status} />
              )}
            </div>
          )}

          {/* ── Pushover No Lineal ───────────────────────────────────────────── */}
          {activeSection === "nl-pushover" && (
            <div className="mx-auto max-w-6xl px-6 py-8 flex flex-col gap-6">
              <div>
                <h1 className="text-xl font-semibold text-[var(--text)]">Pushover No Lineal — Edificio de Muros</h1>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  MVLEM_3D con fibras Concrete02 + Steel02 · carga triangular · DisplacementControl · X e Y
                </p>
              </div>

              <Card>
                <CardBody className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">Pushover X + Y del edificio completo</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      Construye modelo no lineal desde el diseño RC por pier. Aplica cargas gravitacionales
                      y ejecuta pushover triangular hasta {"{target_drift}%"} de deriva de techo.
                    </p>
                  </div>
                  <Button
                    disabled={activeJobTypes.has("nl_pushover") || !hasWallDesign}
                    onClick={() => handleLaunch("nl_pushover")}
                    title={!hasWallDesign ? "Ejecuta primero el diseño de muros RC" : undefined}
                  >
                    {activeJobTypes.has("nl_pushover") ? "Calculando..." : hasNLPushover ? "Recalcular" : "Ejecutar"}
                  </Button>
                </CardBody>
              </Card>

              {hasNLPushover && nlPushoverResult && (
                <NLPushoverPanel result={nlPushoverResult} projectId={project.id} wallDesign={wallDesignResult} />
              )}

              {activeJobTypes.has("nl_pushover") && !hasNLPushover && (
                <Card>
                  <CardBody>
                    <p className="text-sm text-[var(--text-muted)] animate-pulse">
                      Construyendo modelo no lineal y ejecutando pushover... (puede tardar varios minutos)
                    </p>
                  </CardBody>
                </Card>
              )}

              {lastJobByType("nl_pushover")?.status === "failed" && (
                <Card>
                  <CardBody>
                    <p className="text-sm text-red-600 font-medium">Error en el pushover no lineal</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">{lastJobByType("nl_pushover")?.error_message}</p>
                  </CardBody>
                </Card>
              )}
            </div>
          )}

          {/* ── No Lineal ────────────────────────────────────────────────────── */}
          {activeSection === "no-lineal" && (
            <div className="mx-auto max-w-3xl px-6 py-8">
              <NonlinearSpecPanel
                projectId={project.id}
                isValidated={isValidated}
              />
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
