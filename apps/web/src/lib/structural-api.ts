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
