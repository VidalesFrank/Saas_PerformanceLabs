import { getToken } from "./auth";
import { ApiError } from "./api";
import type {
  WallListResponse,
  WallAnalyticalModel,
  WallValidationResult,
  WallHealthResponse,
  WallSettings,
  BulkAssignRequest,
  BulkAssignResponse,
  AutoDiscretizeRequest,
} from "./wall-types";

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
  return res.json() as Promise<T>;
}

// ── Wall list ─────────────────────────────────────────────────────────────────

export function fetchWalls(projectId: string): Promise<WallListResponse> {
  return req(`/${projectId}/walls`);
}

export function fetchWall(projectId: string, wallLabel: string): Promise<{
  label: string;
  shell: Record<string, unknown>;
  analytical: WallAnalyticalModel | null;
}> {
  return req(`/${projectId}/walls/${encodeURIComponent(wallLabel)}`);
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function fetchWallSettings(projectId: string): Promise<WallSettings> {
  return req(`/${projectId}/walls/settings`);
}

export function updateWallSettings(
  projectId: string,
  settings: Partial<WallSettings>,
): Promise<WallSettings> {
  return req(`/${projectId}/walls/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// ── Auto-discretize ───────────────────────────────────────────────────────────

export function autoDiscretize(
  projectId: string,
  wallLabel: string,
  request: AutoDiscretizeRequest,
): Promise<WallAnalyticalModel> {
  return req(
    `/${projectId}/walls/${encodeURIComponent(wallLabel)}/auto-discretize`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

// ── Save / delete ─────────────────────────────────────────────────────────────

export function saveWallModel(
  projectId: string,
  wallLabel: string,
  model: WallAnalyticalModel,
): Promise<WallAnalyticalModel> {
  return req(`/${projectId}/walls/${encodeURIComponent(wallLabel)}`, {
    method: "PUT",
    body: JSON.stringify(model),
  });
}

export function deleteWallAnalytical(
  projectId: string,
  wallLabel: string,
): Promise<{ deleted: string }> {
  return req(`/${projectId}/walls/${encodeURIComponent(wallLabel)}/analytical`, {
    method: "DELETE",
  });
}

// ── Validation & health ───────────────────────────────────────────────────────

export function validateWall(
  projectId: string,
  wallLabel: string,
): Promise<WallValidationResult> {
  return req(`/${projectId}/walls/${encodeURIComponent(wallLabel)}/validate`);
}

export function fetchWallHealth(projectId: string): Promise<WallHealthResponse> {
  return req(`/${projectId}/walls/health`);
}

// ── OpenSeesPy preview ────────────────────────────────────────────────────────

export function fetchOpsPreview(
  projectId: string,
  wallLabel: string,
): Promise<{ preview: string }> {
  return req(`/${projectId}/walls/${encodeURIComponent(wallLabel)}/preview-ops`);
}

// ── Bulk assign ───────────────────────────────────────────────────────────────

export function bulkAssignFormulation(
  projectId: string,
  request: BulkAssignRequest,
): Promise<BulkAssignResponse> {
  return req(`/${projectId}/walls/bulk-assign`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Módulo 5 — WallProject API  (/api/v1/wall-projects)
// ════════════════════════════════════════════════════════════════════════════

import type {
  WallProject5,
  WallJob5,
  WRCDocument,
  ModalResult5,
  PushoverResult5,
  MaterialPresets,
  PushoverDirection,
} from "./wall-types";

const WP_BASE = `${API_URL}/api/v1/wall-projects`;

function authH(): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  const t = getToken();
  if (t) h.set("Authorization", `Bearer ${t}`);
  return h;
}

async function wpReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${WP_BASE}${path}`, { ...opts, headers: authH() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ════════════════════════════════════════════════════════════════════════════
// Wall Design API  (/api/v1/wall-design)
// ════════════════════════════════════════════════════════════════════════════
import type { WallDesignRequest, WallDesignResult } from "./wall-types";

const WD_BASE = `${API_URL}/api/v1/wall-design`;

async function wdReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const h = new Headers({ "Content-Type": "application/json" });
  const token = getToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${WD_BASE}${path}`, { ...opts, headers: h });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const wallDesignApi = {
  compute: (req: WallDesignRequest) =>
    wdReq<WallDesignResult>("/compute", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  barDatabase: () =>
    wdReq<{ db_mm: number; area_mm2: number }[]>("/bar-database"),
};

export const wallProjectsApi = {
  // Projects
  list: () =>
    wpReq<WallProject5[]>(""),

  create: (name: string, description?: string) =>
    wpReq<WallProject5>("", {
      method: "POST",
      body: JSON.stringify({ name, description, initialize_document: true }),
    }),

  get: (id: string) =>
    wpReq<WallProject5>(`/${id}`),

  delete: (id: string) =>
    wpReq<void>(`/${id}`, { method: "DELETE" }),

  // Document
  getDocument: (id: string) =>
    wpReq<WRCDocument>(`/${id}/document`),

  saveDocument: (id: string, doc: WRCDocument) =>
    wpReq<{ ok: boolean; document_hash: string; hash_changed: boolean; status: string }>(
      `/${id}/document`,
      { method: "PUT", body: JSON.stringify(doc) },
    ),

  // Presets
  getDefaultMaterials: () =>
    wpReq<{ schema_version: string; materials: Record<string, import("./wall-types").WRCMaterial> }>("/presets/materials"),

  getAllPresets: () =>
    wpReq<MaterialPresets>("/presets/materials/all"),

  getMvlemBasicSet: (fc_mpa: number, fy_mpa: number, detailing: string, id_prefix: string) =>
    wpReq<{ materials: Record<string, import("./wall-types").WRCMaterial> }>("/presets/mvlem-basic-set", {
      method: "POST",
      body: JSON.stringify({ fc_mpa, fy_mpa, detailing, id_prefix }),
    }),

  // Analysis
  launch: (id: string, job_type: "gravity" | "modal" | "pushover", direction?: PushoverDirection) =>
    wpReq<{ job_id: string; job_type: string; status: string; celery_id: string }>(
      `/${id}/analyze`,
      { method: "POST", body: JSON.stringify({ job_type, direction: direction ?? "X" }) },
    ),

  jobStatus: (projectId: string, jobId: string) =>
    wpReq<WallJob5>(`/${projectId}/jobs/${jobId}/status`),

  jobResult: <T = ModalResult5 | PushoverResult5>(projectId: string, jobId: string) =>
    wpReq<T>(`/${projectId}/jobs/${jobId}/result`),

  listJobs: (projectId: string) =>
    wpReq<WallJob5[]>(`/${projectId}/jobs`),

  // Script export
  downloadScript: async (id: string, name: string) => {
    const token = getToken();
    const h = new Headers();
    if (token) h.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${WP_BASE}/${id}/export-script`, { method: "POST", headers: h });
    if (!res.ok) throw new ApiError(res.status, "Error exportando script");
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `wall_analysis_${name.slice(0,20).replace(/\s/g,"_")}.py`;
    a.click(); URL.revokeObjectURL(url);
  },
};
