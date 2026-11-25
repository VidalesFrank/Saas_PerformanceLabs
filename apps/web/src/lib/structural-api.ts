/**
 * Cliente API para el Módulo 1 — Constructor de Modelos Estructurales.
 * Todos los endpoints requieren autenticación JWT.
 */
import { getToken } from "./auth";
import { ApiError } from "./api";
import type {
  StructuralProject,
  SeismicParameters,
  StructuralJob,
  StructuralAnalysisType,
  ValidationResult,
  ModalResult,
  SpectralResult,
  SpectrumPreviewResult,
  ModelGeometry,
  CombinationsResult,
  FrameListResult,
  ColumnDesignDetail,
  BeamDesignDetail,
  ColumnReinforcementEdit,
  BeamReinforcementEdit,
  FullModelData,
  ModelCheckResult,
  SectionData,
  MaterialData,
  AssignSectionResult,
  NLSpecStatusResult,
  NLSpecGenerateResult,
  GridDefinition,
  MasonryMaterial,
  MasonryBrickType,
  InfillPanel,
  SectionReinforcementList,
  SectionReinforcementItem,
  ReinforcementNSR10Result,
  SaveSectionReinforcementPayload,
  PerformanceCSMResult,
} from "./structural-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const BASE    = `${API_URL}/api/v1/projects`;
const FEMA_BASE  = `${API_URL}/api/v1/fema-library`;
const LOCAL_BASE = `${API_URL}/api/v1/local-catalog`;

function authHeaders(): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  const token = getToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string"
      ? body.detail
      : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function upload<T>(path: string, formData: FormData): Promise<T> {
  const token = getToken();
  const h = new Headers();
  if (token) h.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: h, body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

// ── Proyectos ─────────────────────────────────────────────────────────────────

export const structuralProjectsApi = {
  list: () =>
    req<StructuralProject[]>(""),

  create: (payload: { name: string; description?: string }) =>
    req<StructuralProject>("", { method: "POST", body: JSON.stringify(payload) }),

  /** Crea un proyecto DEMO pre-configurado (pórtico metálico 2×2×2) para
   *  revisión inmediata de la plataforma. */
  createDemoSteelPortal: () =>
    req<StructuralProject>("/demo/steel-portal", { method: "POST" }),

  get: (id: string) =>
    req<StructuralProject>(`/${id}`),

  /** Renombra o ajusta la descripción del proyecto. Solo envía campos definidos. */
  update: (id: string, payload: { name?: string; description?: string | null }) =>
    req<StructuralProject>(`/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  delete: (id: string) =>
    req<void>(`/${id}`, { method: "DELETE" }),

  saveParameters: (id: string, params: SeismicParameters) =>
    req<StructuralProject>(`/${id}/parameters`, {
      method: "PUT",
      body: JSON.stringify(params),
    }),

  uploadModel: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("model_file", file);
    return upload<StructuralProject>(`/${id}/upload-model`, fd);
  },

  uploadE2K: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("e2k_file", file);
    return upload<StructuralProject>(`/${id}/upload-e2k`, fd);
  },

  jobs: (id: string) =>
    req<StructuralJob[]>(`/${id}/jobs`),

  spectrumPreview: (id: string, Aa: number, Av: number, soil_type: string, T_max = 4.0) =>
    req<SpectrumPreviewResult>(`/${id}/spectrum-preview`, {
      method: "POST",
      body: JSON.stringify({ Aa, Av, soil_type, T_max }),
    }),

  modelGeometry: (id: string) =>
    req<ModelGeometry>(`/${id}/model-geometry`),

  getCombinations: (id: string) =>
    req<CombinationsResult>(`/${id}/combinations`),

  saveCombinations: (id: string, selectedIds: string[]) =>
    req<{ selected_ids: string[] }>(`/${id}/combinations`, {
      method: "PUT",
      body: JSON.stringify({ selected_ids: selectedIds }),
    }),

  /**
   * Descarga el proyecto como .plabs.json autocontenido. Dispara el guardado
   * via <a download> en el navegador y resuelve con el nombre de archivo usado.
   */
  exportProject: async (
    id: string,
    opts: { include_reinforcement?: boolean; include_design?: boolean } = {},
  ): Promise<{ filename: string; size_bytes: number }> => {
    const token = getToken();
    const qs = new URLSearchParams({
      include_reinforcement: String(opts.include_reinforcement ?? true),
      include_design:        String(opts.include_design ?? true),
    });
    const h = new Headers();
    if (token) h.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${BASE}/${id}/export?${qs}`, { headers: h });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      throw new ApiError(res.status, detail);
    }
    const blob = await res.blob();
    // Nombre del header o fallback
    const disp = res.headers.get("Content-Disposition") || "";
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? `project_${id}.plabs.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { filename, size_bytes: blob.size };
  },

  /** Sube un .plabs.json y crea un proyecto nuevo bajo la cuenta actual. */
  importProject: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return upload<StructuralProject>("/import", fd);
  },
};

// ── Análisis ──────────────────────────────────────────────────────────────────

export const structuralAnalysisApi = {
  launch: (projectId: string, analysisType: StructuralAnalysisType, extraParams?: Record<string, unknown>) =>
    req<StructuralJob>("/analysis/launch", {
      method: "POST",
      body: JSON.stringify({
        project_id:    projectId,
        analysis_type: analysisType,
        extra_params:  extraParams,
      }),
    }),

  jobStatus: (jobId: string) =>
    req<StructuralJob>(`/analysis/jobs/${jobId}`),

  result: <T = ValidationResult | ModalResult | SpectralResult>(jobId: string) =>
    req<T>(`/analysis/jobs/${jobId}/result`),

  cancel: (jobId: string) =>
    req<{ detail: string }>(`/analysis/jobs/${jobId}/cancel`, { method: "DELETE" }),

  downloadUrl: (jobId: string) =>
    `${BASE}/analysis/jobs/${jobId}/download`,

  /** Historia comprimida del pushover no lineal para animación de deformada. */
  nlPushoverHistory: (projectId: string, direction: string, maxFrames = 60) =>
    req<import("./structural-types").NLPushoverHistory>(
      `/analysis/${projectId}/nl-pushover/${direction}/history?max_frames=${maxFrames}`,
    ),

  /** Curvas M-φ y V-δ locales de un pier específico durante el pushover. */
  nlPushoverPierResponse: (projectId: string, direction: string, pier: string, story: string) =>
    req<import("./structural-types").PierResponseData>(
      `/analysis/${projectId}/nl-pushover/${direction}/pier-response` +
      `?pier=${encodeURIComponent(pier)}&story=${encodeURIComponent(story)}`,
    ),

  // ── Variantes de diseño (Fase 6) ─────────────────────────────────────────
  listDesignVariants: (projectId: string) =>
    req<import("./structural-types").DesignVariantsResponse>(
      `/analysis/${projectId}/design-variants`,
    ),

  createDesignVariant: (projectId: string, name: string, description = "") =>
    req<import("./structural-types").DesignVariant>(
      `/analysis/${projectId}/design-variants`,
      { method: "POST", body: JSON.stringify({ name, description }) },
    ),

  updateDesignVariant: (
    projectId: string,
    variantId: string,
    payload: { name?: string; description?: string; overrides?: Record<string, import("./structural-types").DesignVariantOverride | null> },
  ) =>
    req<import("./structural-types").DesignVariant>(
      `/analysis/${projectId}/design-variants/${variantId}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  deleteDesignVariant: (projectId: string, variantId: string) =>
    req<{ deleted: string }>(
      `/analysis/${projectId}/design-variants/${variantId}`,
      { method: "DELETE" },
    ),

  /** Lanza el pushover no lineal sobre la variante (Sprint 6.2). */
  analyzeDesignVariant: (projectId: string, variantId: string) =>
    req<StructuralJob>(
      `/analysis/${projectId}/design-variants/${variantId}/analyze`,
      { method: "POST" },
    ),

  /** Retorna el resultado del pushover NL de la variante. */
  getDesignVariantResult: (projectId: string, variantId: string) =>
    req<import("./structural-types").NLPushoverVariantResult>(
      `/analysis/${projectId}/design-variants/${variantId}/result`,
    ),

  // ── Pushover no lineal de pórticos (F2-F6) ──────────────────────────────

  /** Resultado consolidado del pushover de pórticos (JSON). */
  getNLFramePushover: (projectId: string) =>
    req<import("./structural-types").NLFramePushoverResult>(
      `/analysis/${projectId}/nl-frame-pushover`,
    ),

  /** Historia submuestreada para animación 3D + daño por rótula. */
  nlFramePushoverHistory: (projectId: string, direction: string, maxFrames = 60) =>
    req<import("./structural-types").NLFramePushoverHistory>(
      `/analysis/${projectId}/nl-frame-pushover/${direction}/history?max_frames=${maxFrames}`,
    ),

  /** Respuesta local (curvatura-paso) de un extremo i|j de un elemento. */
  nlFrameElementResponse: (
    projectId: string, direction: string, fid: string, end: "i" | "j" = "i",
  ) =>
    req<import("./structural-types").FrameElementResponse>(
      `/analysis/${projectId}/nl-frame-pushover/${direction}/element-response` +
      `?fid=${encodeURIComponent(fid)}&end=${end}`,
    ),

  /** URL del XLSX con resumen + curvas + rótulas + metadata. */
  nlFramePushoverXlsxUrl: (projectId: string) =>
    `${BASE}/analysis/${projectId}/nl-frame-pushover/export/xlsx`,

  /** Calcula punto de desempeño por el método N2 (síncrono).
   *  `system` rutea el pushover fuente: "frames" (pórticos) o "walls" (muros). */
  computeN2: (
    projectId: string,
    direction: "X" | "Y",
    system: "frames" | "walls" = "frames",
  ) =>
    req<import("./structural-types").N2Result>(
      `/analysis/${projectId}/${system === "walls" ? "nl-pushover" : "nl-frame-pushover"}/${direction}/n2`,
      { method: "POST" },
    ),

  /** Lee el último resultado N2 persistido. */
  getN2: (
    projectId: string,
    direction: "X" | "Y",
    system: "frames" | "walls" = "frames",
  ) =>
    req<import("./structural-types").N2Result>(
      `/analysis/${projectId}/${system === "walls" ? "nl-pushover" : "nl-frame-pushover"}/${direction}/n2`,
    ),

  // ── NLTHA (análisis cronológico no lineal) ────────────────────────────────

  /** Sube un archivo ACC (una aceleración por línea) para el NLTHA.
   *  `direction` es "X" o "Y". Devuelve la ruta absoluta del archivo en el
   *  worker que debes pasar en el launch. */
  uploadNLTHRecord: async (
    projectId: string,
    direction: "X" | "Y",
    file: File,
  ): Promise<import("./structural-types").NLTHUploadResult> => {
    const url  = `${BASE}/analysis/${projectId}/nlth/upload-record?direction=${direction}`;
    const form = new FormData();
    form.append("file", file);
    const token = getToken();
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    const res   = await fetch(url, { method: "POST", body: form, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Upload falló (${res.status})`);
    }
    return res.json();
  },

  /** Lee el último `nlth_results.json` persistido. */
  getNLTHResult: (projectId: string) =>
    req<import("./structural-types").NLTHResult>(
      `/analysis/${projectId}/nlth/result`,
    ),

  /** Historial de análisis NLTH del proyecto. */
  listNLTHJobs: (projectId: string) =>
    req<{ jobs: import("./structural-types").NLTHJobMeta[] }>(
      `/analysis/${projectId}/nlth/jobs`,
    ).then((r) => r.jobs),

  /** Lee el resultado de un job histórico específico. */
  getNLTHResultByJob: (projectId: string, jobId: string) =>
    req<import("./structural-types").NLTHResult>(
      `/analysis/${projectId}/nlth/result/${jobId}`,
    ),

  /** Activa un job histórico como "el último" (afecta verificador, export, etc.) */
  activateNLTHJob: (projectId: string, jobId: string) =>
    req<{ ok: boolean; activated_job_id: string }>(
      `/analysis/${projectId}/nlth/activate/${jobId}`,
      { method: "POST" },
    ),

  /** Borra un job histórico del disco. */
  deleteNLTHJob: (projectId: string, jobId: string) =>
    req<{ ok: boolean; deleted_job_id: string }>(
      `/analysis/${projectId}/nlth/${jobId}`,
      { method: "DELETE" },
    ),

  /** Importa un bundle NLTH JSON externo como nuevo job del proyecto. */
  importNLTHBundle: (
    projectId: string,
    bundle: { export_meta?: unknown; result?: unknown } | import("./structural-types").NLTHResult,
  ) =>
    req<{ ok: boolean; job_id: string; meta: Record<string, unknown>; message: string }>(
      `/analysis/${projectId}/nlth/import`,
      { method: "POST", body: JSON.stringify(bundle) },
    ),

  /** Lee el último `modal_results.json` persistido (para T1 en escalado FEMA). */
  getModalResult: (projectId: string) =>
    req<ModalResult & { T1?: number; T1_x?: number; T1_y?: number }>(
      `/analysis/${projectId}/modal/result`,
    ),

  /** Lee el último `spectral_results.json` persistido (espectro NSR-10 + FHE). */
  getSpectralResult: (projectId: string) =>
    req<SpectralResult & { spectrum?: { T_values: number[]; Sa: number[] } }>(
      `/analysis/${projectId}/spectral/result`,
    ),

  /** Lista los registros X/Y ya subidos — para re-poblar el UI al montar. */
  listNLTHRecords: (projectId: string) =>
    req<{ X: import("./structural-types").NLTHUploadResult | null;
          Y: import("./structural-types").NLTHUploadResult | null; }>(
      `/analysis/${projectId}/nlth/records`,
    ),

  /** Selecciona un par de la biblioteca FEMA P-695 → copia los dos archivos
   *  al workspace y calcula el escalado. Compatible con `uploadX/Y`. */
  selectFEMAPair: (
    projectId: string,
    body: {
      pair_id:      number;
      scale_mode:   "manual" | "sa_target" | "nsr10";
      scale_manual?: number;
      T1_s?:        number;
      sa_target_g?: number;
      xi?:          number;
    },
  ) =>
    req<import("./structural-types").FEMASelectResult>(
      `/analysis/${projectId}/nlth/select-library-pair`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Defaults globales + rangos observados por elemento (sliders). */
  getNLTHThresholdsMeta: (projectId: string) =>
    req<import("./structural-types").NLTHThresholdsMeta>(
      `/analysis/${projectId}/nlth/thresholds-meta`,
    ),

  /** Re-ejecuta el detector con umbrales custom sobre el NPZ existente. */
  recomputeNLTHEvents: (
    projectId: string,
    overrides: Partial<Record<
      "eps_sy" | "eps_cu_cover" | "eps_cu_core" | "eps_su" | "eps_bk",
      number
    >>,
  ) =>
    req<{ status: string; n_events: number;
          events: import("./structural-types").LocalEventsPayload }>(
      `/analysis/${projectId}/nlth/recompute-events`,
      { method: "POST", body: JSON.stringify(overrides) },
    ),

  /** Clasifica columnas por modo de falla (ASCE 41 × hinges NLTHA). */
  recomputeNLTHFailureModes: (projectId: string) =>
    req<{ status: string; n_total: number;
          counts: Record<import("./structural-types").FailureCategory, number>;
          failure_modes: import("./structural-types").FailureModesClassification }>(
      `/analysis/${projectId}/nlth/recompute-failure-modes`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /** Ola 7 — Diagnóstico completo de un elemento con recomendaciones de refuerzo.
   *  Si `theta_demand_override` no se pasa, usa el valor de nlth_results.json
   *  (damage.hinges o pathological_element). */
  getElementDiagnosis: (
    projectId: string,
    fid: string,
    overrides?: { theta_demand?: number; V_demand_kN?: number; method?: string },
  ) => {
    const qs = new URLSearchParams();
    if (overrides?.theta_demand != null)
      qs.set("theta_demand_override", String(overrides.theta_demand));
    if (overrides?.V_demand_kN != null)
      qs.set("V_demand_kN_override", String(overrides.V_demand_kN));
    if (overrides?.method) qs.set("method", overrides.method);
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<import("./structural-types").ElementDiagnosis>(
      `/analysis/${projectId}/nlth/element-diagnosis/${encodeURIComponent(fid)}${suffix}`,
    );
  },

  /** Ola 7 — Persiste un override de refuerzo (invalidando el nonlinear_model.json).
   *  Al relanzar NLTH/Pushover el motor leerá los cambios automáticamente. */
  applyReinforcementFix: (
    projectId: string,
    body: import("./structural-types").ApplyReinforcementFixRequest,
  ) =>
    req<import("./structural-types").ApplyReinforcementFixResponse>(
      `/analysis/${projectId}/nlth/apply-reinforcement-fix`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Ola 8 — Verifica (y opcionalmente ajusta) el refuerzo para cumplir
   *  θ_target por nivel de desempeño ASCE 41-17. */
  verifyPerformanceCapacity: (
    projectId: string,
    body: import("./structural-types").PerformanceVerifyRequest,
  ) =>
    req<import("./structural-types").PerformanceVerificationResult>(
      `/analysis/${projectId}/verify-performance-capacity`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Lee el último reporte de verificación performance-based. */
  getPerformanceVerification: (projectId: string) =>
    req<import("./structural-types").PerformanceVerificationResult>(
      `/analysis/${projectId}/verify-performance-capacity`,
    ),

  // ── IDA (Incremental Dynamic Analysis) ─────────────────────────────────
  launchIDA: (
    projectId: string,
    body: import("./structural-types").IDALaunchRequest,
  ) =>
    req<import("./structural-types").IDALaunchResponse>(
      `/analysis/${projectId}/ida/launch`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  getIDAResult: (projectId: string) =>
    req<import("./structural-types").IDAResult>(
      `/analysis/${projectId}/ida/result`,
    ),

  getIDAProgress: (projectId: string, jobId: string) =>
    req<import("./structural-types").IDAProgress>(
      `/analysis/${projectId}/ida/progress/${encodeURIComponent(jobId)}`,
    ),

  listIDAJobs: (projectId: string) =>
    req<import("./structural-types").IDAJobSummary[]>(
      `/analysis/${projectId}/ida/jobs`,
    ),

  // ── NLRHA (verificación NSR-10 / ASCE 7-22 Cap 16) ─────────────────────
  launchNLRHA: (
    projectId: string,
    body: import("./structural-types").NLRHALaunchRequest,
  ) =>
    req<import("./structural-types").NLRHALaunchResponse>(
      `/analysis/${projectId}/nlrha/launch`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  getNLRHAResult: (projectId: string) =>
    req<import("./structural-types").NLRHAResult>(
      `/analysis/${projectId}/nlrha/result`,
    ),

  listNLRHAJobs: (projectId: string) =>
    req<import("./structural-types").IDAJobSummary[]>(
      `/analysis/${projectId}/nlrha/jobs`,
    ),
};

// ── Editor del modelo estructural ────────────────────────────────────────────

export const structuralEditorApi = {
  /** Carga el modelo canónico completo para el editor (sin analysis_results). */
  modelData: (projectId: string) =>
    req<FullModelData>(`/${projectId}/model-data`),

  /** Ejecuta el health check del modelo y retorna errores/advertencias. */
  modelCheck: (projectId: string) =>
    req<ModelCheckResult>(`/${projectId}/model-check`),

  /** Lista joints donde convergen frames de concreto y de acero (apoyos
   *  de cubierta metálica, bases de columnas steel sobre dados RC, etc.). */
  getMixedInterfaces: (projectId: string) =>
    req<{
      interfaces: Array<{
        joint_id: string;
        x: number; y: number; z: number;
        elev_m: number;
        concrete_frames: string[];
        steel_frames: string[];
        is_roof_support: boolean;
      }>;
      summary: { total: number; roof_supports: number; mid_transitions: number };
    }>(`/${projectId}/model/mixed-interfaces`),

  // ── Secciones ────────────────────────────────────────────────────────────

  createSection: (projectId: string, name: string, data: Omit<SectionData, "A_m2" | "I33_m4" | "I22_m4" | "J_m4" | "E_mpa" | "G_mpa"> & Partial<Pick<SectionData, "A_m2" | "I33_m4" | "I22_m4" | "J_m4">>) =>
    req<{ ok: boolean; name: string; data: SectionData }>(
      `/${projectId}/model/sections`,
      { method: "POST", body: JSON.stringify({ name, ...data }) },
    ),

  updateSection: (projectId: string, name: string, data: Omit<SectionData, "A_m2" | "I33_m4" | "I22_m4" | "J_m4" | "E_mpa" | "G_mpa"> & Partial<Pick<SectionData, "A_m2" | "I33_m4" | "I22_m4" | "J_m4">>) =>
    req<{ ok: boolean; name: string; data: SectionData }>(
      `/${projectId}/model/sections/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify(data) },
    ),

  deleteSection: (projectId: string, name: string) =>
    req<{ ok: boolean; deleted: string; frames_affected: number }>(
      `/${projectId}/model/sections/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  /** Catálogo de perfiles metálicos (AISC + europeos DIN 1025 + colombianos
   *  PTE/PHR paramétricos) + grados ASTM/DIN. */
  getSteelCatalog: () =>
    req<{
      shapes_by_type: Record<string, Array<{
        name: string; A_mm2: number; d_mm: number; bf_mm: number;
        weight_kgm: number; Ix_mm4: number; Iy_mm4: number;
        Zx_mm3: number; Zy_mm3: number;
      }>>;
      parametric_shapes: Record<string, {
        label: string;
        sizes: Array<{ name: string; d_mm?: number; b_mm?: number; OD_mm?: number }>;
        default_thicknesses_mm: number[];
        user_adjustable_thickness: boolean;
      }>;
      grades: Array<{
        name: string; fy_mpa: number; fu_mpa: number;
        E_mpa: number; G_mpa: number; eps_y: number;
      }>;
      total_shapes: number;
    }>(`/steel/catalog`),

  /** Crea una sección metálica desde perfil (AISC, DIN o PTE/PHR colombiano)
   *  + grado ASTM/DIN. Auto-crea el material de acero si no existe.
   *  Para PTE/PHR, `thickness_mm` define el espesor del tubo. */
  createSteelSection: (
    projectId: string,
    payload: { name: string; shape_name: string; grade: string; thickness_mm?: number },
  ) =>
    req<{
      ok: boolean;
      name: string;
      material_created: string;
      data: Record<string, unknown>;
    }>(
      `/${projectId}/model/steel-sections`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  // ── Materiales ────────────────────────────────────────────────────────────

  createMaterial: (projectId: string, name: string, data: Partial<MaterialData> & { type: string }) =>
    req<{ ok: boolean; name: string; data: MaterialData }>(
      `/${projectId}/model/materials`,
      { method: "POST", body: JSON.stringify({ name, ...data }) },
    ),

  updateMaterial: (projectId: string, name: string, data: Partial<MaterialData> & { type: string }) =>
    req<{ ok: boolean; name: string; data: MaterialData }>(
      `/${projectId}/model/materials/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify(data) },
    ),

  deleteMaterial: (projectId: string, name: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/materials/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  // ── Asignación de sección a frames ───────────────────────────────────────

  assignSection: (projectId: string, frameIds: string[], sectionName: string) =>
    req<AssignSectionResult>(
      `/${projectId}/model/frames/assign-section`,
      {
        method: "POST",
        body: JSON.stringify({ frame_ids: frameIds, section_name: sectionName }),
      },
    ),

  restoreSections: (projectId: string, assignments: Record<string, string>) =>
    req<{ ok: boolean; restored: number }>(
      `/${projectId}/model/frames/restore-sections`,
      { method: "POST", body: JSON.stringify({ assignments }) },
    ),

  // ── Grid definido por el usuario ─────────────────────────────────────────
  upsertGrid: (projectId: string, grid: GridDefinition) =>
    req<{ ok: boolean; grid: GridDefinition }>(
      `/${projectId}/model/grid`,
      { method: "PUT", body: JSON.stringify(grid) },
    ),

  // ── Materiales de mampostería ────────────────────────────────────────────
  createMasonryMaterial: (
    projectId: string,
    payload: { id: string; name: string; fm_mpa: number; brick_type: MasonryBrickType; Em_mpa?: number | null },
  ) =>
    req<{ ok: boolean; id: string; data: MasonryMaterial }>(
      `/${projectId}/model/masonry-materials`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateMasonryMaterial: (
    projectId: string, materialId: string,
    payload: { name: string; fm_mpa: number; brick_type: MasonryBrickType; Em_mpa?: number | null },
  ) =>
    req<{ ok: boolean; id: string; data: MasonryMaterial }>(
      `/${projectId}/model/masonry-materials/${encodeURIComponent(materialId)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  deleteMasonryMaterial: (projectId: string, materialId: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/masonry-materials/${encodeURIComponent(materialId)}`,
      { method: "DELETE" },
    ),

  // ── Infills (paneles de mampostería) ─────────────────────────────────────
  createInfill: (
    projectId: string,
    payload: { id: string; column_i_fid?: string; column_j_fid?: string;
               pier?: string; story: string; thickness_m: number;
               masonry_material_id: string; opening_ratio?: number; width_ratio?: number },
  ) =>
    req<{ ok: boolean; id: string; data: InfillPanel }>(
      `/${projectId}/model/infills`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateInfill: (
    projectId: string, infillId: string,
    payload: { column_i_fid?: string; column_j_fid?: string; pier?: string;
               story: string; thickness_m: number;
               masonry_material_id: string; opening_ratio: number; width_ratio: number },
  ) =>
    req<{ ok: boolean; id: string; data: InfillPanel }>(
      `/${projectId}/model/infills/${encodeURIComponent(infillId)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  deleteInfill: (projectId: string, infillId: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/infills/${encodeURIComponent(infillId)}`,
      { method: "DELETE" },
    ),

  replicateInfill: (
    projectId: string,
    payload: { source_infill_id: string; target_stories: string[];
               xy_tol_m?: number; id_prefix?: string | null },
  ) =>
    req<{
      ok: boolean; source: string;
      created: InfillPanel[]; skipped: { story: string; reason: string }[];
      n_created: number; n_skipped: number;
    }>(
      `/${projectId}/model/infills/replicate`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  // ── Joints / Frames / Shells (soporte de dibujo directo) ─────────────────
  createJoint: (
    projectId: string,
    payload: { id: string; x: number; y: number; z: number; story?: string;
               is_restrained?: boolean; restraints?: number[] | null },
  ) =>
    req<{ ok: boolean; id: string; data: Record<string, unknown> }>(
      `/${projectId}/model/joints`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  deleteJoint: (projectId: string, jointId: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/joints/${encodeURIComponent(jointId)}`,
      { method: "DELETE" },
    ),

  /** Actualiza posición (x, y, z) de un joint — frames y shells conectados
   *  se mueven con él automáticamente. */
  updateJoint: (
    projectId: string, jointId: string,
    patch: { x?: number; y?: number; z?: number; story?: string },
  ) =>
    req<{ ok: boolean; id: string; data: Record<string, unknown> }>(
      `/${projectId}/model/joints/${encodeURIComponent(jointId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  createFrame: (
    projectId: string,
    payload: { id: string; joint_i: string; joint_j: string; section: string;
               element_type: "column" | "beam"; story?: string },
  ) =>
    req<{ ok: boolean; id: string; data: Record<string, unknown> }>(
      `/${projectId}/model/frames`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  deleteFrame: (projectId: string, frameId: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/frames/${encodeURIComponent(frameId)}`,
      { method: "DELETE" },
    ),

  /** Actualiza sección, release y/o story de un frame. */
  updateFrame: (
    projectId: string, frameId: string,
    patch: { section?: string; release?: "" | "i" | "j" | "ij"; story?: string },
  ) =>
    req<{ ok: boolean; id: string; data: Record<string, unknown> }>(
      `/${projectId}/model/frames/${encodeURIComponent(frameId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  createShell: (
    projectId: string,
    payload: { id: string; joints: string[]; section?: string;
               element_type: "wall" | "slab"; thickness_m: number;
               pier?: string; story?: string },
  ) =>
    req<{ ok: boolean; id: string; data: Record<string, unknown> }>(
      `/${projectId}/model/shells`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  deleteShell: (projectId: string, shellId: string) =>
    req<{ ok: boolean; deleted: string }>(
      `/${projectId}/model/shells/${encodeURIComponent(shellId)}`,
      { method: "DELETE" },
    ),

  /** Reemplaza la lista de pisos con diafragma rígido. */
  upsertRigidDiaphragms: (projectId: string, rigidStories: string[]) =>
    req<{ ok: boolean; rigid_diaphragms: string[] }>(
      `/${projectId}/model/rigid-diaphragms`,
      { method: "PUT", body: JSON.stringify({ rigid_stories: rigidStories }) },
    ),

  /** Reemplaza la lista de patrones de carga. Al eliminar un patrón, se
   *  limpian en cascada line_loads y shell_loads asignados a él. */
  upsertLoadPatterns: (projectId: string, patterns: string[]) =>
    req<{
      ok: boolean;
      patterns: string[];
      removed_patterns: string[];
      line_loads_cleaned: number;
      shell_loads_cleaned: number;
    }>(
      `/${projectId}/model/load-patterns`,
      { method: "PUT", body: JSON.stringify({ patterns }) },
    ),

  /** Asigna cargas lineales (kN/m, gravedad Z) a una viga por patrón.
   *  Patron con valor 0 limpia la asignación de ese patrón. */
  upsertLineLoad: (projectId: string, frameId: string, loads: Record<string, number>) =>
    req<{ ok: boolean; frame_id: string; loads: Record<string, number> }>(
      `/${projectId}/model/line-loads/${encodeURIComponent(frameId)}`,
      { method: "PUT", body: JSON.stringify({ loads }) },
    ),

  /** Asigna presión uniforme (kN/m², gravedad Z) a una losa por patrón.
   *  Patron con valor 0 limpia la asignación de ese patrón. */
  upsertShellLoad: (projectId: string, shellId: string, loads: Record<string, number>) =>
    req<{ ok: boolean; shell_id: string; loads: Record<string, number> }>(
      `/${projectId}/model/shell-loads/${encodeURIComponent(shellId)}`,
      { method: "PUT", body: JSON.stringify({ loads }) },
    ),

  /** Refleja elementos seleccionados respecto a una línea paralela al eje X o Y. */
  mirrorElements: (
    projectId: string,
    payload: {
      elements: Array<{ kind: "column" | "beam" | "wall" | "slab"; id: string }>;
      axis:  "x" | "y";
      coord: number;
      xy_tol_m?: number;
    },
  ) =>
    req<{
      ok: boolean;
      frames_created: number;
      shells_created: number;
      warnings: string[];
      new_ids: { frames: string[]; shells: string[] };
    }>(
      `/${projectId}/model/mirror`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  /** Replica un muro o losa N-1 veces en array lineal. */
  replicateShell: (
    projectId: string, shellId: string,
    payload: { dx: number; dy: number; count: number; xy_tol_m?: number },
  ) =>
    req<{ ok: boolean; shells_created: number; new_ids: string[] }>(
      `/${projectId}/model/shells/${encodeURIComponent(shellId)}/replicate`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  /** Copia todos los elementos de un piso a otro (columnas + vigas + muros + losas). */
  copyStory: (
    projectId: string,
    payload: {
      source_story:   string;
      target_story:   string;
      include_frames?: boolean;
      include_shells?: boolean;
      xy_tol_m?:       number;
    },
  ) =>
    req<{
      ok: boolean;
      source_story: string;
      target_story: string;
      joints_created: number;
      joints_reused:  number;
      frames_created: number;
      shells_created: number;
      warnings: string[];
      new_ids: { joints: string[]; frames: string[]; shells: string[] };
    }>(
      `/${projectId}/model/stories/copy`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
};

// ── Diseño detallado por frame ────────────────────────────────────────────────

export const structuralDesignApi = {
  listFrames: (projectId: string) =>
    req<FrameListResult>(`/${projectId}/design/frames`),

  getFrame: (projectId: string, frameId: string) =>
    req<ColumnDesignDetail | BeamDesignDetail>(`/${projectId}/design/frames/${encodeURIComponent(frameId)}`),

  saveReinforcement: (
    projectId: string,
    frameId: string,
    reinforcement: ColumnReinforcementEdit | BeamReinforcementEdit,
    notes?: string,
  ) =>
    req<{ frame_id: string; saved: boolean; message: string }>(
      `/${projectId}/design/frames/${encodeURIComponent(frameId)}/reinforcement`,
      {
        method: "PUT",
        body: JSON.stringify({ reinforcement, notes }),
      },
    ),

  /** Aplica un patrón de refuerzo a varios frames de la misma sección y tipo. */
  bulkSaveReinforcement: (
    projectId: string,
    args: {
      frame_ids: string[];
      reinforcement: ColumnReinforcementEdit | BeamReinforcementEdit;
      notes?: string;
      pattern_label?: string;
    },
  ) =>
    req<{
      saved:         boolean;
      n_frames:      number;
      frame_ids:     string[];
      bulk_batch_id: string;
      pattern_label: string | null;
      element_type:  "column" | "beam";
      section:       string;
      message:       string;
    }>(
      `/${projectId}/design/frames/reinforcement/bulk`,
      {
        method: "PUT",
        body: JSON.stringify(args),
      },
    ),

  verifyFrame: (
    projectId: string,
    frameId: string,
    reinforcement: ColumnReinforcementEdit | BeamReinforcementEdit,
  ) =>
    req<{ overall_ok: boolean; max_dcr: number; checks: Record<string, unknown> }>(
      `/${projectId}/design/frames/${encodeURIComponent(frameId)}/verify`,
      {
        method: "POST",
        body: JSON.stringify({ reinforcement }),
      },
    ),

  // ── Patrones de refuerzo por sección (as-built) ─────────────────────────
  listSectionReinforcement: (projectId: string) =>
    req<SectionReinforcementList>(`/${projectId}/design/sections`),

  saveSectionReinforcement: (
    projectId:    string,
    elementType:  "column" | "beam",
    sectionName:  string,
    payload:      SaveSectionReinforcementPayload,
  ) =>
    req<{
      ok:            boolean;
      section_key:   string;
      n_elements:    number;
      pattern_label: string | null;
      message:       string;
    }>(
      `/${projectId}/design/sections/${elementType}/${encodeURIComponent(sectionName)}/reinforcement`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  deleteSectionReinforcement: (
    projectId:   string,
    elementType: "column" | "beam",
    sectionName: string,
  ) =>
    req<{ ok: boolean; removed: boolean; section_key?: string; message?: string }>(
      `/${projectId}/design/sections/${elementType}/${encodeURIComponent(sectionName)}/reinforcement`,
      { method: "DELETE" },
    ),

  listFrameOverrides: (projectId: string) =>
    req<{
      overrides: Record<string, {
        reinforcement: unknown;
        source:        string | null;
        pattern_label: string | null;
        notes:         string | null;
        saved_at:      string | null;
      }>;
      n_total: number;
    }>(`/${projectId}/design/overrides`),

  deleteFrameReinforcement: (projectId: string, frameId: string) =>
    req<{ ok: boolean; removed: boolean; frame_id: string }>(
      `/${projectId}/design/frames/${encodeURIComponent(frameId)}/reinforcement`,
      { method: "DELETE" },
    ),

  validateSectionReinforcement: (
    projectId:   string,
    elementType: "column" | "beam",
    sectionName: string,
    payload: Pick<
      SaveSectionReinforcementPayload,
      "longitudinal" | "transverse" | "zones" | "shear"
    >,
  ) =>
    req<ReinforcementNSR10Result>(
      `/${projectId}/design/sections/${elementType}/${encodeURIComponent(sectionName)}/validate-nsr10`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
};

// Re-export para que los consumidores no tengan que importar desde types
export type { SectionReinforcementItem };

const NL_BASE = `${API_URL}/api/v1/projects/nonlinear`;

function authHeadersNL(): Headers {
  const h = new Headers();
  const token = getToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function nlReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${NL_BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, err.detail ?? "Error desconocido");
  }
  return res.json() as Promise<T>;
}

export const nlSpecApi = {
  getStatus: (projectId: string) =>
    nlReq<NLSpecStatusResult>(`/${projectId}/spec`),

  generate: (projectId: string) =>
    nlReq<NLSpecGenerateResult>(`/${projectId}/spec/generate`, { method: "POST" }),

  download: async (projectId: string): Promise<void> => {
    const token = getToken();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${NL_BASE}/${projectId}/spec/download`, { headers });
    if (!res.ok) throw new ApiError(res.status, "Error descargando spec");
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `nonlinear_model_${projectId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  upload: async (projectId: string, file: File): Promise<NLSpecGenerateResult> => {
    const headers = authHeadersNL();
    const form    = new FormData();
    form.append("file", file);
    const res = await fetch(`${NL_BASE}/${projectId}/spec/upload`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, err.detail ?? "Error cargando spec");
    }
    return res.json() as Promise<NLSpecGenerateResult>;
  },

  deleteSpec: (projectId: string) =>
    nlReq<{ ok: boolean; message: string }>(`/${projectId}/spec`, { method: "DELETE" }),
};


// ─────────────────────────────────────────────────────────────────────────────
// Fase 7 — umbrales por elemento (basados en Fases 1-6)
// ─────────────────────────────────────────────────────────────────────────────
export type RotationMethod = "mecanico" | "ec8_3" | "haselton";
export type UmbralesMode   = "FEMA" | "elemento" | "ambos";

export interface DamageStateConfig {
  id:                string;
  name:              string;
  threshold_source:  string;
  repair_action:     string;
  beta_override:     number | null;
}

export interface ElementThresholdRow {
  fid:              string;
  kind:             string;
  story:            string;
  section:          string;
  failure_mode:     string;
  asce_condition:   string;
  flags:            string[];
  Vp_kN:            number;
  Vn_kN:            number;
  Vp_over_Vn:       number;
  M_peak_kNm:       number;
  phi_u_rad_per_m:  number;
  method:           string;
  Lp_mm:            number;
  Lp_source:        string;
  theta_y:          number;
  theta_IO:         number;
  theta_LS:         number;
  theta_CP:         number;
  theta_u:          number;
  lambda_imk:       number | null;
  Mc_over_My:       number | null;
  medians_DS:       Record<string, number>;
  betas_DS:         Record<string, number>;
  has_measured_Lp:  boolean;
  damage_notes:     string | null;
}

export interface ElementThresholdResult {
  metodo_rotacion:       RotationMethod;
  metodo_umbrales:       UmbralesMode;
  beta_global:           number;
  beta_poor_detailing:   number;
  rows:                  ElementThresholdRow[];
  fragilities:           Record<string, {
    fid: string;
    medians: Record<string, number>;
    betas: Record<string, number>;
    ds_catalog: DamageStateConfig[];
  }>;
  n_elements:            number;
  n_with_lp_measured:    number;
  n_poor_detailing:      number;
  warnings:              string[];
}

export interface FieldObservation {
  L_p_measured_mm?: number;
  L_p_method?:      string;
  hook_type?:       string;
  splice_in_hinge?: boolean;
  fu_MPa?:          number;
  eps_su?:          number;
  damage_notes?:    string;
  photo_path?:      string;
}

export const elementThresholdsApi = {
  compute: (projectId: string, params: {
    metodo_rotacion?:     RotationMethod;
    metodo_umbrales?:     UmbralesMode;
    beta_global?:         number;
    beta_poor_detailing?: number;
    ds_catalog?:          DamageStateConfig[];
  }) =>
    req<ElementThresholdResult>(`/analysis/${projectId}/element-thresholds`, {
      method: "POST",
      body:   JSON.stringify(params),
    }),

  get: (projectId: string) =>
    req<ElementThresholdResult>(`/analysis/${projectId}/element-thresholds`),

  getDSCatalog: (projectId: string) =>
    req<DamageStateConfig[]>(`/analysis/${projectId}/damage-states-catalog`),

  putDSCatalog: (projectId: string, catalog: DamageStateConfig[]) =>
    req<{ saved: boolean; n_states: number }>(
      `/analysis/${projectId}/damage-states-catalog`,
      { method: "PUT", body: JSON.stringify(catalog) },
    ),

  getFieldObservations: (projectId: string) =>
    req<{ observations: Record<string, FieldObservation>; n_elements: number }>(
      `/analysis/${projectId}/field-observations`,
    ),

  uploadFieldObservations: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return upload<{ saved: boolean; n_elements: number }>(
      `/analysis/${projectId}/field-observations`, fd,
    );
  },

  putFieldObservation: (projectId: string, fid: string, obs: FieldObservation & { fid: string }) =>
    req<{ saved: boolean; fid: string }>(
      `/analysis/${projectId}/field-observations/${fid}`,
      { method: "PUT", body: JSON.stringify(obs) },
    ),

  applyLpToSection: (projectId: string, section_name: string, kind: "column" | "beam", L_p_measured_mm: number) =>
    req<{ applied_to: string[]; n_elements: number }>(
      `/analysis/${projectId}/field-observations/apply-lp-to-section`,
      {
        method: "POST",
        body:   JSON.stringify({ section_name, kind, L_p_measured_mm }),
      },
    ),

  getElementDemand: (projectId: string) =>
    req<ElementDemandResult>(`/analysis/${projectId}/element-demand`),
};

// Demanda unificada (NLTHA / pushover) por elemento
export interface ElementDemandEntry {
  theta_p_max:        number;
  end_at_max:         string;
  direction_at_max:   string;
  level:              "none" | "near_io" | "io" | "ls" | "cp" | "collapse";
  theta_IO_fema?:     number | null;
  theta_LS_fema?:     number | null;
  theta_CP_fema?:     number | null;
  kind?:              string | null;
  story?:             string | null;
  source:             "nlth" | "pushover";
}

export interface ElementDemandResult {
  source:            "none" | "nlth" | "pushover" | "both";
  by_fid:            Record<string, ElementDemandEntry>;
  n_elements:        number;
  n_from_nlth:       number;
  n_from_pushover:   number;
}

// ── FEMA P-695 Far-Field library (biblioteca global de registros) ───────────

async function femaReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${FEMA_BASE}${path}`, { ...opts, headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string"
      ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const femaLibraryApi = {
  /** Catálogo completo con espectros precomputados a 5 % ξ. */
  listPairs: () =>
    femaReq<import("./structural-types").FEMALibraryCatalog>("/pairs"),

  /** Timeseries decimado para preview rápido (hasta 600 muestras). */
  getRecordPreview: (gmName: string, maxPoints = 600) =>
    femaReq<import("./structural-types").FEMARecordPreview>(
      `/record/${gmName}/preview?max_points=${maxPoints}`,
    ),

  /** Calcula el factor de escala FEMA P-695 (geomean) para alcanzar Sa objetivo. */
  computeScale: (body: {
    pair_id:     number;
    T1_s:        number;
    sa_target_g: number;
    xi?:         number;
  }) =>
    femaReq<import("./structural-types").FEMAScaleResult>("/scale-factor", {
      method: "POST", body: JSON.stringify(body),
    }),
};

// ── Catálogos sísmicos locales (campañas colombianas, p.ej. 10-ago-2026) ────

async function localReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${LOCAL_BASE}${path}`, { ...opts, headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string"
      ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const localCatalogApi = {
  /** Lista de campañas con registros disponibles en DB. */
  listCampaigns: () =>
    localReq<{ campaigns: import("./structural-types").LocalCampaign[] }>("/campaigns"),

  /** Catálogo completo con espectros precomputados (shape FEMAPair extendido). */
  getCatalog: (campaign: string) =>
    localReq<import("./structural-types").LocalCatalog>(
      `/catalog?campaign=${encodeURIComponent(campaign)}`,
    ),

  /** Timeseries decimado para preview rápido. */
  getRecordPreview: (recordName: string, maxPoints = 600, campaign = "colombia_2026_08_10") =>
    localReq<import("./structural-types").LocalRecordPreview>(
      `/record/${encodeURIComponent(recordName)}/preview?max_points=${maxPoints}&campaign=${encodeURIComponent(campaign)}`,
    ),

  /** Factor de escala FEMA P-695 §6.2 para un par del catálogo local. */
  computeScale: (body: {
    pair_id:     number;
    T1_s:        number;
    sa_target_g: number;
    campaign:    string;
    xi?:         number;
  }) =>
    localReq<import("./structural-types").FEMAScaleResult & { campaign: string }>(
      "/scale-factor",
      { method: "POST", body: JSON.stringify(body) },
    ),
};


// ── Performance CSM (Capacity Spectrum Method ATC-40) ─────────────────────────

export const structuralPerformanceApi = {
  evaluateCSM: (payload: {
    project_id:     string;
    direction?:     "X" | "Y";
    dtecho_pct:     number[];
    vbasal_norm:    number[];
    total_height_m: number;
    T1_s:           number;
    Aa?:            number;
    Av?:            number;
  }) =>
    req<PerformanceCSMResult>("/performance/csm/evaluate", {
      method: "POST",
      body:   JSON.stringify(payload),
    }),

  /** Resultado NL pushover ya persistido (walls). */
  getNLPushoverResult: (projectId: string) =>
    req<import("./structural-types").NLPushoverResult>(
      `/analysis/${projectId}/nl-pushover`,
    ),

  /** Resultado NL pushover de pórticos ya persistido. */
  getNLFramePushoverResult: (projectId: string) =>
    req<import("./structural-types").NLFramePushoverResult>(
      `/analysis/${projectId}/nl-frame-pushover`,
    ),
};
