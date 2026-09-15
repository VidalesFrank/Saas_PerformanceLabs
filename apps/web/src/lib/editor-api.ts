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

export interface PMKeyPoint {
  p_kn: number;
  m_knm: number;
}

export interface InteractionResult {
  section_id: string;
  points: InteractionPoint2[];
  p_max_kn: number;
  p_min_kn: number;
  m_max_knm: number;
  key_points?: {
    compression_pure?: PMKeyPoint;
    balanced?: PMKeyPoint;
    pure_flexure?: PMKeyPoint;
    tension_pure?: PMKeyPoint;
  };
  theta_deg?: number;
  num_points_computed?: number;
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

export interface GeometricPropertiesEngineering {
  gross_area_cm2: number;
  net_area_cm2: number;
  steel_area_cm2: number;
  rho_g_pct: number;
  centroid_y_cm: number;
  centroid_z_cm: number;
  depth_cm: number;
  width_cm: number;
  Iy_cm4: number;
  Iz_cm4: number;
  Iyz_cm4: number;
  Sy_pos_cm3: number;
  Sy_neg_cm3: number;
  Sz_pos_cm3: number;
  Sz_neg_cm3: number;
  ry_cm: number;
  rz_cm: number;
  Zpy_cm3: number;
  Zpz_cm3: number;
  fs_y: number;
  fs_z: number;
  I1_cm4: number;
  I2_cm4: number;
  theta_p_deg: number;
}

export interface GeometricPropertiesResult {
  section_id: string;
  si: Record<string, number>;      // valores en unidades SI base (mm, mm², mm³, mm⁴)
  engineering: GeometricPropertiesEngineering;
}

export interface ShearCheckRequest {
  code: "NSR-10" | "ACI 318-19";
  element: "beam" | "column" | "wall";
  ductility: "DMI" | "DMO" | "DES";
  Vu_kN: number;
  Nu_kN?: number;
  Mu_kNm?: number;
  Av_mm2?: number | null;
  s_mm?: number;
  fyt_MPa?: number;
  d_mm?: number | null;
  bw_mm?: number | null;
  rho_w?: number;
  lambda_c?: number;
  db_long_mm?: number;
}

export interface DuctilityRequest {
  axial_load_kn: number;
  member_length_mm?: number;
  db_long_mm?: number;
  Lp_method?: "priestley_2007" | "paulay_priestley" | "baker" | "atc_32";
  fu_over_fy?: number;
  theta_deg?: number;
}

export interface ServiceabilityRequest {
  Ma_kNm?: number;
  element_kind?: "beam" | "column" | "wall" | "slab_2d" | "diaphragm";
  lambda_c?: number;
  wall_cracked?: boolean;
}

export interface DesignRequest {
  geometry: {
    kind: "column_rect" | "column_circ";
    height_mm?: number;
    width_mm?: number;
    diameter_mm?: number;
    cover_mm?: number;
    fpc_MPa?: number;
    fy_MPa?: number;
  };
  demands: { Pu_kN: number; Mux_kNm?: number; Muy_kNm?: number }[];
  ductility?: "DMI" | "DMO" | "DES";
  top_k?: number;
  rho_min?: number;
  rho_max?: number | null;
}

export interface DesignCandidate {
  n_bars: number;
  bar_size: string;
  layout: string;
  n_bars_y: number;
  n_bars_z: number;
  As_cm2: number;
  rho_g_pct: number;
  max_DCR: number;
  worst_demand_idx: number;
  demand_DCRs: number[];
  all_pass: boolean;
  P0_kN: number;
}

export interface DesignResult {
  n_candidates_evaluated: number;
  n_valid: number;
  all_infeasible: boolean;
  candidates: DesignCandidate[];
  notes: string[];
}

export interface CyclicRequest {
  axial_load_kn?: number;
  protocol?: "atc_24" | "sinusoidal" | "user";
  phi_yield_1_per_m?: number;
  phi_max_1_per_m?: number;
  ductilities?: number[];
  cycles_per_step?: number;
  n_cycles?: number;
  decay?: number;
  steps_per_cycle?: number;
  phi_history_1_per_m?: number[];
  theta_deg?: number;
}

export interface CyclicResult {
  section_id: string;
  protocol: string;
  axial_load_kn: number;
  curve: { phi_1_per_m: number; moment_kNm: number }[];
  cycles: {
    peak_pos_phi_1_per_m: number;
    peak_neg_phi_1_per_m: number;
    peak_pos_M_kNm: number;
    peak_neg_M_kNm: number;
    Ed_kNm2: number;
    Es_kNm2: number;
    xi_eq_pct: number;
    K_sec_pos_kNm2: number;
    K_sec_neg_kNm2: number;
  }[];
  total_energy_dis_kN: number;
  n_points: number;
  n_cycles: number;
  notes: string[];
}

export interface ServiceabilityResult {
  section_id: string;
  input: Record<string, number | string | boolean>;
  materials: { fr_MPa: number; Ec_MPa: number; Es_MPa: number; n: number };
  cracking: { Mcr_kNm: number; Mcr_neg_kNm: number; yt_mm: number; Ig_cm4: number };
  cracked_section: { Icr_cm4: number; c_neutral_mm: number };
  effective: { Ie_cm4: number; phi_cr_1_per_km: number; phi_service_1_per_km: number };
  nsr10_A53: { element_kind: string; Ie_over_Ig: number; Ie_recommended_cm4: number };
  notes: string[];
}

export interface DuctilityResult {
  section_id: string;
  input: Record<string, number | string>;
  bilinear: {
    phi_yield_ideal_1_per_m: number;
    moment_yield_ideal_kNm: number;
    phi_ultimate_1_per_m: number;
    moment_ultimate_kNm: number;
  };
  ductility: {
    mu_phi: number;
    mu_delta: number;
  };
  plastic_hinge: {
    Lp_mm: number;
    Lp_over_L: number;
    method: string;
  };
  energy: {
    capacity_kNm_per_m: number;
  };
  curve: { phi_1_per_m: number; moment_kNm: number }[];
  notes: string[];
}

export interface ShearCheckResult {
  section_id: string;
  code: string;
  element: string;
  ductility: string;
  geometry_used: {
    bw_mm: number; d_mm: number; Ag_mm2: number;
    fpc_MPa: number; dim_min_mm: number;
  };
  components: {
    Vc_kN: number; Vs_kN: number; Vn_kN: number;
    phi_Vn_kN: number; Vu_kN: number; DCR: number;
  };
  detailing: {
    s_max_mm: number;
    Av_min_mm2: number;
  };
  status: "ok" | "warning" | "fail" | "no-transverse";
  articles: Record<string, string>;
  notes: string[];
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
  interaction: (id: string, numPoints = 40, thetaDeg = 0) =>
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

  geometricProperties: (id: string) =>
    req<GeometricPropertiesResult>(`/${id}/geometric-properties`),

  shearCheck: (id: string, request: ShearCheckRequest) =>
    req<ShearCheckResult>(`/${id}/shear-check`, {
      method: "POST",
      body: JSON.stringify(request),
    }),

  ductility: (id: string, request: DuctilityRequest) =>
    req<DuctilityResult>(`/${id}/ductility`, {
      method: "POST",
      body: JSON.stringify(request),
    }),

  serviceability: (id: string, request: ServiceabilityRequest) =>
    req<ServiceabilityResult>(`/${id}/serviceability`, {
      method: "POST",
      body: JSON.stringify(request),
    }),

  cyclic: (id: string, request: CyclicRequest) =>
    req<CyclicResult>(`/${id}/cyclic`, {
      method: "POST",
      body: JSON.stringify(request),
    }),

  designColumn: (request: DesignRequest) =>
    req<DesignResult>(`/design-column`, {
      method: "POST",
      body: JSON.stringify(request),
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
