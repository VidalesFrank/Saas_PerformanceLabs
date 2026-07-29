/**
 * Cliente API para el Módulo 2 v2 — editor de secciones.
 * Todos los endpoints usan /api/v1/editor/sections.
 */
import { getToken } from "./auth";
import { ApiError } from "./api";
import type { SectionDocument, SectionRecord, SectionSummary } from "./section-document";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const BASE = `${API_URL}/api/v1/editor/sections`;

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
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Tipos de respuesta ─────────────────────────────────────────────────────────

export interface InteractionPoint2 {
  p_kn: number;
  m_knm: number;
}

export interface InteractionResult {
  section_id: string;
  points: InteractionPoint2[];
  p_max_kn: number;
  p_min_kn: number;
  m_max_knm: number;
}

export interface MCPoint2 {
  phi: number;    // 1/m
  moment: number; // kN·m
}

export interface MomentCurvatureResult {
  section_id: string;
  axial_load_kn: number;
  curve: MCPoint2[];
  phi_yield: number;
  moment_yield: number;
  phi_max: number;
  moment_max: number;
  phi_ultimate: number;
  moment_ultimate: number;
  ductility: number;
  ei_secant_kNm2: number;
  failure_reached: boolean;
}

export interface PMMPoint2 {
  p: number;
  mx: number;
  my: number;
}

export interface PMMArc2 {
  theta_deg: number;
  points: PMMPoint2[];
}

export interface PMMDemand {
  p_kn: number;
  mx_knm: number;
  my_knm: number;
}

export interface PMMDemandResult extends PMMDemand {
  m_demand_knm: number;
  m_capacity_knm: number;
  dcr: number;
  inside: boolean;
}

export interface PMMSurfaceResult {
  section_id: string;
  curves: PMMArc2[];
  p_max_kn: number;
  p_min_kn: number;
  m_max_knm: number;
  demands_out: PMMDemandResult[];
}

// ── API ────────────────────────────────────────────────────────────────────────

export const sectionEditorApi = {
  // CRUD
  list: () => req<SectionSummary[]>(""),

  create: (payload: { name: string; description?: string; document: SectionDocument }) =>
    req<SectionRecord>("", { method: "POST", body: JSON.stringify(payload) }),

  get: (id: string) => req<SectionRecord>(`/${id}`),

  update: (id: string, payload: { name?: string; description?: string; document?: SectionDocument }) =>
    req<SectionRecord>(`/${id}`, { method: "PUT", body: JSON.stringify(payload) }),

  delete: (id: string) => req<void>(`/${id}`, { method: "DELETE" }),

  // Análisis (POST — el engine corre en el servidor)
  interaction: (id: string, numPoints = 15, thetaDeg = 0) =>
    req<InteractionResult>(`/${id}/interaction-diagram`, {
      method: "POST",
      body: JSON.stringify({ num_points: numPoints, theta_deg: thetaDeg }),
    }),

  momentCurvature: (id: string, axialLoadKn = 0, numIncr = 120, curvatureMultiple = 8.0, thetaDeg = 0) =>
    req<MomentCurvatureResult>(`/${id}/moment-curvature`, {
      method: "POST",
      body: JSON.stringify({ axial_load_kn: axialLoadKn, num_incr: numIncr, curvature_multiple: curvatureMultiple, theta_deg: thetaDeg }),
    }),

  pmm: (id: string, numAngles = 8, numPoints = 10, demands: PMMDemand[] = []) =>
    req<PMMSurfaceResult>(`/${id}/pmm-surface`, {
      method: "POST",
      body: JSON.stringify({ num_angles: numAngles, num_points: numPoints, demands }),
    }),

  nsr10: (id: string, elementType: string, ductility: string) =>
    req<NSR10Result>(`/${id}/nsr10-check`, {
      method: "POST",
      body: JSON.stringify({ element_type: elementType, ductility }),
    }),
};

// ── Tipos NSR-10 ───────────────────────────────────────────────────────────────

export interface NSR10CheckItem {
  article: string;
  description: string;
  demand: number;
  limit: number;
  unit: string;
  status: "ok" | "fail" | "warning" | "info";
  note: string;
}

export interface NSR10Result {
  section_id: string;
  element_type: string;
  ductility: string;
  summary: { ok: number; fail: number; warning: number; total: number };
  checks: NSR10CheckItem[];
}
