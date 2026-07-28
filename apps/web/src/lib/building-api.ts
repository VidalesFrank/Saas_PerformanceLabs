/**
 * Cliente API para el Módulo 3 — Análisis No Lineal 3D de Edificios.
 * Todos los endpoints requieren autenticación JWT.
 */
import { getToken } from "./auth";
import { ApiError } from "./api";
import type {
  BuildingProject,
  BuildingParameters,
  BuildingJob,
  AnalysisType,
  PushoverParams,
  DynamicParams,
  ModalResult,
  PushoverResult,
  DynamicResult,
} from "./building-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const BASE    = `${API_URL}/api/v1/building`;

function authHeaders(): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  const token = getToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: authHeaders(),
  });
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

export const buildingProjectsApi = {
  list: () =>
    req<BuildingProject[]>("/projects"),

  create: (payload: { name: string; description?: string }) =>
    req<BuildingProject>("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  get: (id: string) =>
    req<BuildingProject>(`/projects/${id}`),

  delete: (id: string) =>
    req<void>(`/projects/${id}`, { method: "DELETE" }),

  saveParameters: (id: string, params: BuildingParameters) =>
    req<BuildingProject>(`/projects/${id}/parameters`, {
      method: "PUT",
      body: JSON.stringify(params),
    }),

  uploadModel: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("model_file", file);
    return upload<BuildingProject>(`/projects/${id}/upload-model`, fd);
  },

  uploadE2K: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("e2k_file", file);
    return upload<BuildingProject>(`/projects/${id}/upload-e2k`, fd);
  },

  uploadRebar: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("rebar_file", file);
    return upload<BuildingProject>(`/projects/${id}/upload-rebar`, fd);
  },

  jobs: (id: string) =>
    req<BuildingJob[]>(`/projects/${id}/jobs`),
};

// ── Análisis ──────────────────────────────────────────────────────────────────

export const buildingAnalysisApi = {
  launch: (
    projectId: string,
    analysisType: AnalysisType,
    params?: { pushoverParams?: PushoverParams; dynamicParams?: DynamicParams },
  ) =>
    req<BuildingJob>("/analysis/launch", {
      method: "POST",
      body: JSON.stringify({
        project_id:      projectId,
        analysis_type:   analysisType,
        pushover_params: params?.pushoverParams,
        dynamic_params:  params?.dynamicParams,
      }),
    }),

  jobStatus: (jobId: string) =>
    req<BuildingJob>(`/analysis/jobs/${jobId}`),

  result: <T = ModalResult | PushoverResult | DynamicResult>(jobId: string) =>
    req<T>(`/analysis/jobs/${jobId}/result`),

  cancel: (jobId: string) =>
    req<{ detail: string }>(`/analysis/jobs/${jobId}/cancel`, { method: "DELETE" }),

  downloadUrl: (jobId: string) =>
    `${BASE}/analysis/jobs/${jobId}/download`,
};
