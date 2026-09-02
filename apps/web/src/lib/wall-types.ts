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
