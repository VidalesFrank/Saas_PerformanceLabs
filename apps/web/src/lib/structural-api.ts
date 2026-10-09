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
} from "./structural-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const BASE    = `${API_URL}/api/v1/projects`;

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

  get: (id: string) =>
    req<StructuralProject>(`/${id}`),

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
};

// ── Editor del modelo estructural ────────────────────────────────────────────

export const structuralEditorApi = {
  /** Carga el modelo canónico completo para el editor (sin analysis_results). */
  modelData: (projectId: string) =>
    req<FullModelData>(`/${projectId}/model-data`),

  /** Ejecuta el health check del modelo y retorna errores/advertencias. */
  modelCheck: (projectId: string) =>
    req<ModelCheckResult>(`/${projectId}/model-check`),

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
};

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
