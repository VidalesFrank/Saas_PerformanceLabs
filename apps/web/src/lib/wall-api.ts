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
