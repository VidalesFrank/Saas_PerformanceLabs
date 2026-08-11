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
};
