// ── Wall Analytical Model Types — Módulo 1 Constructor de Modelos ─────────────

export type WallFormulation = "MVLEM_3D" | "SFI_MVLEM_3D" | "E_SFI_MVLEM_3D";

export type MacroFiberRegion = "boundary_left" | "web" | "boundary_right";

export interface MacroFiber {
  index:          number;
  width_m:        number;
  thickness_m:    number;
  region:         MacroFiberRegion;
  rho_vertical:   number;
  rho_horizontal: number;
  concrete_name:  string;
  steel_v_name:   string;
  steel_h_name:   string;
  rc_panel_key:   string;
}

// ── Wall analytical model (matches Python to_dict()) ─────────────────────────

export interface WallAnalyticalModel {
  formulation:   WallFormulation;
  nodes:         string[];          // [iNode, jNode, kNode, lNode]
  n_fibers:      number;
  total_width_m: number;
  macrofibers:   MacroFiber[];
  density_t_m3:  number;
  source_pier:   string;
  source_story:  string;
  c_rot?:        number;
  thick_mod?:    number;
  poisson?:      number;
}

// ── Physical zone definitions (used for auto-discretization request) ──────────

export interface BoundaryZoneIn {
  width_m:        number;
  thickness_m?:   number;
  rho_vertical:   number;
  rho_horizontal?: number;
  concrete_name?: string;
  steel_v_name?:  string;
  steel_h_name?:  string;
}

export interface WebZoneIn {
  thickness_m:    number;
  rho_vertical:   number;
  rho_horizontal: number;
  concrete_name?: string;
  steel_v_name?:  string;
  steel_h_name?:  string;
}

export interface AutoDiscretizeRequest {
  wall_length_m:    number;
  wall_thickness_m: number;
  left_boundary?:   BoundaryZoneIn;
  web:              WebZoneIn;
  right_boundary?:  BoundaryZoneIn;
  n_fibers?:        number;
  formulation?:     WallFormulation;
  node_i?:          string;
  node_j?:          string;
  node_k?:          string;
  node_l?:          string;
  c_rot?:           number;
  thick_mod?:       number;
  poisson?:         number;
  density_t_m3?:    number;
  source_pier?:     string;
  source_story?:    string;
}

// ── Wall list item (from GET /walls) ─────────────────────────────────────────

export interface WallListItem {
  label:          string;
  story:          string;
  area_label:     string;
  joints:         string[];
  section:        string;
  thickness_m:    number;
  has_analytical: boolean;
  formulation:    WallFormulation | null;
  n_fibers:       number | null;
  source_pier:    string;
  source_story:   string;
}

export interface WallListResponse {
  walls:      WallListItem[];
  total:      number;
  configured: number;
  incomplete: number;
  invalid:    number;
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface WallCheckResult {
  code:    string;
  ok:      boolean;
  message: string;
}

export interface WallValidationResult {
  is_valid:   boolean;
  checks:     WallCheckResult[];
  n_errors:   number;
  n_warnings: number;
}

// ── Wall health (GET /walls/health) ──────────────────────────────────────────

export interface WallHealthIssue {
  label:   string;
  code:    string;
  message: string;
}

export interface WallHealthResponse {
  total:      number;
  configured: number;
  incomplete: number;
  invalid:    number;
  warnings:   number;
  issues:     WallHealthIssue[];
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface WallSettings {
  default_formulation: WallFormulation;
  default_n_fibers:    number;
  default_c_rot:       number;
  default_thick_mod:   number;
  default_poisson:     number;
}

// ── Bulk assign ───────────────────────────────────────────────────────────────

export interface BulkAssignRequest {
  wall_labels:  string[];
  formulation:  WallFormulation;
  n_fibers:     number;
  c_rot:        number;
  thick_mod:    number;
  poisson:      number;
}

export interface BulkAssignResponse {
  updated: number;
  skipped: number;
  labels:  string[];
}

// ── Formulation metadata (static) ────────────────────────────────────────────

export interface FormulationInfo {
  value:       WallFormulation;
  label:       string;
  description: string;
  uses_rc_panel: boolean;
  recommended: boolean;
}

export const WALL_FORMULATIONS: FormulationInfo[] = [
  {
    value:        "MVLEM_3D",
    label:        "MVLEM_3D",
    description:  "Multiple Vertical Line Element Model — flexure-dominated response, no shear-flexure coupling. Best for slender walls (H/L > 3). No horizontal reinforcement required.",
    uses_rc_panel: false,
    recommended:  false,
  },
  {
    value:        "SFI_MVLEM_3D",
    label:        "SFI-MVLEM-3D",
    description:  "Shear-Flexure Interaction MVLEM — couples in-plane shear and flexure via RC Panel (FSAM) material. Full interaction formulation; requires ρₕ per fiber.",
    uses_rc_panel: true,
    recommended:  false,
  },
  {
    value:        "E_SFI_MVLEM_3D",
    label:        "E-SFI-MVLEM-3D",
    description:  "Efficient SFI-MVLEM — same physics as SFI-MVLEM-3D with reduced DOFs for improved convergence in 3D building models. Recommended for walls with H/L ≤ 3.",
    uses_rc_panel: true,
    recommended:  true,
  },
];

export function getFormulationInfo(f: WallFormulation): FormulationInfo {
  return WALL_FORMULATIONS.find(x => x.value === f) ?? WALL_FORMULATIONS[2];
}

export function regionLabel(region: MacroFiberRegion): string {
  return {
    boundary_left:  "Left Boundary",
    web:            "Web",
    boundary_right: "Right Boundary",
  }[region] ?? region;
}

// ════════════════════════════════════════════════════════════════════════════
// Módulo 5 — WallProject (análisis independiente de muros RC 3D)
// ════════════════════════════════════════════════════════════════════════════

export type WallProjectStatus = "empty" | "ready" | "running" | "done";
export type WallJobType       = "gravity" | "modal" | "pushover";
export type WallJobStatus5    = "pending" | "running" | "success" | "failed" | "cancelled";
export type PushoverDirection = "X" | "-X" | "Y" | "-Y";

// ── Material catalog ──────────────────────────────────────────────────────────

export type MaterialKind =
  | "ConcreteCM"
  | "Concrete02"
  | "Hysteretic"
  | "HystereticSM"
  | "Elastic";

export interface WRCMaterial {
  id:         string;
  name:       string;
  kind:       MaterialKind;
  mode:       string;
  unitWeight?: number;
  provenance?: Record<string, unknown>;
  // ConcreteCM fields
  fpcc?: number; epcc?: number; Ec?: number; rc?: number; xcrn?: number;
  ft?: number; et?: number; rt?: number; xcrp?: number; gapClose?: number;
  // Concrete02 fields
  fpc?: number; epsc0?: number; fpcu?: number; epsU?: number; lamb?: number; Ets?: number;
  // Hysteretic fields
  positive?: [number, number][]; negative?: [number, number][];
  pinchX?: number; pinchY?: number; damage1?: number; damage2?: number; beta?: number;
  minStrain?: number; maxStrain?: number;
  // Elastic fields
  stiffness?: number;
}

// ── Wall config ───────────────────────────────────────────────────────────────

export interface WRCMacroFiber {
  width_m:               number;
  thickness_m:           number;
  rho_vertical:          number;
  rho_horizontal?:       number;
  concrete_material_id:  string;
  steel_v_material_id:   string;
  steel_h_material_id?:  string;
}

export interface WRCWall {
  id:            string;
  name:          string;
  formulation:   WallFormulation;
  height_m:      number;
  length_m:      number;
  thickness_m:   number;
  n_fibers:      number;
  x0_m:          number;
  y0_m:          number;
  direction:     "X" | "Y";
  c_rot:         number;
  thick_mod:     number;
  poisson:       number;
  density_t_m3:  number;
  macrofibers:   WRCMacroFiber[];
}

// ── Analysis settings ─────────────────────────────────────────────────────────

export interface WRCAnalysis {
  gravity_steps:             number;
  modal_modes:               number;
  pushover_directions:       PushoverDirection[];
  target_drift_pct:          number;
  displacement_increment_m:  number;
}

// ── Full project document (wrc-1.0) ───────────────────────────────────────────

export interface WRCDocument {
  schema_version: string;
  name:           string;
  detailing:      string;
  units:          { length: string; force: string; mass: string };
  materials:      Record<string, WRCMaterial>;
  walls:          WRCWall[];
  analysis:       WRCAnalysis;
  gravity_loads?: Record<string, number>;  // wall_id → kN
}

// ── API responses ─────────────────────────────────────────────────────────────

export interface WallProject5 {
  id:            string;
  name:          string;
  description:   string | null;
  status:        WallProjectStatus;
  document_hash: string | null;
  has_document:  boolean;
  created_at:    string;
  updated_at:    string;
  latest_job?: {
    id:         string;
    job_type:   WallJobType;
    status:     WallJobStatus5;
    created_at: string;
  };
}

export interface WallJob5 {
  id:             string;
  job_type:       WallJobType;
  status:         WallJobStatus5;
  push_direction: PushoverDirection | null;
  result_summary: Record<string, unknown> | null;
  error_message:  string | null;
  created_at:     string;
  finished_at:    string | null;
}

// ── Analysis results ──────────────────────────────────────────────────────────

export interface ModalResult5 {
  status:           string;
  n_modes:          number;
  eigenvalues:      number[];
  periods_s:        number[];
  frequencies_hz:   number[];
}

export interface PushoverStep {
  step:           number;
  displacement_m: number;
  drift_pct:      number;
  base_shear_kN:  number;
}

export interface PushoverResult5 {
  status:           string;
  direction:        string;
  converged_steps:  number;
  total_steps:      number;
  target_drift_pct: number;
  steps:            PushoverStep[];
  summary: {
    max_drift_pct:      number;
    max_base_shear_kN:  number;
    last_displacement_m: number;
  };
}

// ── Material preset response ──────────────────────────────────────────────────

export interface MaterialPresets {
  concretecm: WRCMaterial[];
  bars:       WRCMaterial[];
  wwm:        WRCMaterial;
}

// ════════════════════════════════════════════════════════════════════════════
// Diseño de Muros RC — NSR-10 / ACI 318-25
// ════════════════════════════════════════════════════════════════════════════

export type WallDuctility = "DES" | "DMO";
export type WallDesignMode = "auto" | "manual";

export interface WallDesignDemand {
  label: string;
  Pu_kN: number;
  Vu_kN: number;
  Mu_kNm: number;
  is_seismic: boolean;
}

export interface BoundaryZoneDesign {
  n_bars: number;
  db_mm: number;
  cover_mm: number;
  tie_db_mm: number;
  tie_spacing_mm: number;
  length_m: number;
  As_mm2: number;
}

export interface WebZoneDesign {
  vert_db_mm: number;
  vert_spacing_mm: number;
  horiz_db_mm: number;
  horiz_spacing_mm: number;
  n_curtains: number;
  rho_v: number;
  rho_h: number;
}

export interface WallDesignReinforcement {
  be_left: BoundaryZoneDesign;
  be_right: BoundaryZoneDesign;
  web: WebZoneDesign;
}

export interface WallNeutralAxis {
  c_m: number;
  a_m: number;
  beta1: number;
  Pn_kN: number;
  Mn_kNm: number;
  phi: number;
  phiPn_kN: number;
  phiMn_kNm: number;
  steel_strains: number[];
  ok: boolean;
  message: string;
}

export interface WallBoundaryElement {
  required: boolean;
  method: "stress" | "displacement" | "none";
  lc_m: number;
  c_m: number;
  sigma_max_mpa: number;
  threshold_mpa: number;
  c_limit_m: number | null;
  drift_ratio: number | null;
  message: string;
}

export interface WallConfinement {
  Ash_req_mm2: number;
  Ash_prov_mm2: number;
  s_mm: number;
  s_max_code_mm: number;
  ok_ash: boolean;
  ok_spacing: boolean;
  message: string;
}

export interface WallShearResult {
  hw_lw: number;
  alpha_c: number;
  Acv_m2: number;
  Vn_max_kN: number;
  phi_Vn_kN: number;
  Vu_kN: number;
  rho_t_req: number;
  rho_t_prov: number;
  rho_v_prov: number;
  Vn_limit_kN: number;
  ok_shear: boolean;
  ok_rho_t: boolean;
  ok_rho_v: boolean;
  ok_vn_limit: boolean;
}

export interface WallInteractionDiagram {
  Pn_kN: number[];
  Mn_kNm: number[];
  phiPn_kN: number[];
  phiMn_kNm: number[];
}

export interface WallDesignDemandPoint {
  label: string;
  Pu_kN: number;
  Mu_kNm: number;
  Vu_kN: number;
  inside: boolean;
  is_seismic: boolean;
}

export interface WallCodeCheck {
  article: string;
  description: string;
  demand: number;
  capacity: number;
  unit: string;
  ok: boolean;
  dcr: number;
}

export interface WallDesignBar {
  x: number;   // posición desde extremo izquierdo (m)
  As: number;  // área (mm²)
}

export interface WallDesignResult {
  ok: boolean;
  governing_combo: string;
  ductility: WallDuctility;
  mode: WallDesignMode;
  geometry: { lw_m: number; tw_m: number; hw_m: number };
  bars: WallDesignBar[];
  reinforcement: WallDesignReinforcement;
  neutral_axis: WallNeutralAxis;
  boundary_element: WallBoundaryElement;
  confinement: WallConfinement | null;
  shear: WallShearResult;
  interaction: WallInteractionDiagram;
  demand_points: WallDesignDemandPoint[];
  checks: WallCodeCheck[];
  summary: {
    total_checks: number;
    failed_checks: number;
    ebe_required: boolean;
    c_m: number;
    lc_m: number;
    phi_Mn_kNm: number;
    phi_Vn_kN: number;
  };
}

export interface WallDesignRequest {
  lw_m: number;
  tw_m: number;
  hw_m: number;
  fc_mpa: number;
  fy_mpa: number;
  fyt_mpa: number;
  ductility: WallDuctility;
  demands: WallDesignDemand[];
  mode: WallDesignMode;
  cover_mm: number;
  delta_u_hw?: number;
}
