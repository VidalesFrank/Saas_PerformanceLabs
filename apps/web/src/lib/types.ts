export type Nivel = "free" | "pro" | "premium" | null;
export type Estado = "idea" | "en_desarrollo" | "listo";

export interface CatalogProduct {
  id: string;
  name: string;
  nivel: Nivel;
  estado: Estado;
  route: string | null;
}

export interface CatalogModule {
  id: string;
  name: string;
  products: CatalogProduct[];
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  plan: "free" | "pro" | "premium";
  created_at: string;
}

export type ShapeType = "rectangular" | "square" | "circular" | "special";

export interface SectionCreatePayload {
  name: string;
  project_id?: string | null;
  shape_type: ShapeType;
  width?: number;
  height?: number;
  diameter?: number;
  vertices?: [number, number][];
  core_vertices?: [number, number][];
  cover: number;
  fpc: number;
  fy: number;
  es: number;
  hoop_bar_diameter?: number;
  hoop_spacing?: number;
  hoop_legs_x?: number;
  hoop_legs_y?: number;
  hoop_leg_area?: number;
  is_spiral?: boolean;
  n_bars_y?: number;
  n_bars_z?: number;
  n_bars?: number;
  bars?: [number, number][];
  bar_id: string;
  cover_to_bar_centroid?: number;
}

export interface SectionOut {
  id: string;
  name: string;
  project_id: string | null;
  shape_type: ShapeType;
  geometry: Record<string, unknown>;
  materials: Record<string, unknown>;
  reinforcement: Record<string, unknown>;
  cover: number;
  created_at: string;
}

export interface InteractionPoint {
  P: number;
  M: number;
}

export interface InteractionResultOut {
  id: string;
  section_id: string;
  points: InteractionPoint[];
  result_metadata: Record<string, number>;
  created_at: string;
}

// ── Interaccion Biaxial P-M-M ────────────────────────────────────────────────

export interface PMMPointOut {
  p: number;    // kN
  mx: number;   // kN·m
  my: number;   // kN·m
}

export interface PMMArcOut {
  theta_deg: number;
  points: PMMPointOut[];
}

export interface PMMDemandOut {
  p_kn: number;
  mx_knm: number;
  my_knm: number;
  m_demand_knm: number;
  m_capacity_knm: number;
  dcr: number;
  inside: boolean;
}

export interface PMMSurfaceResultOut {
  section_id: string;
  curves: PMMArcOut[];
  p_max_kn: number;
  p_min_kn: number;
  m_max_knm: number;
  demands_out: PMMDemandOut[];
}

// ── Momento-Curvatura ─────────────────────────────────────────────────────────

export interface MCPoint {
  phi: number;    // 1/m
  moment: number; // kN·m
}

export interface MomentCurvatureResultOut {
  section_id: string;
  axial_load_kn: number;
  curve: MCPoint[];
  phi_yield: number;        // 1/m  — curvatura bilineal idealizada de fluencia
  moment_yield: number;     // kN·m — momento real en phi_yield
  phi_max: number;          // 1/m  — curvatura en momento pico
  moment_max: number;       // kN·m — momento pico
  phi_ultimate: number;     // 1/m  — curvatura de falla (~80% Mmax post-pico)
  moment_ultimate: number;  // kN·m — momento en curvatura de falla
  ductility: number;        // μφ = φu_falla / φy
  ei_secant_kNm2: number;   // kN·m² — rigidez secante efectiva
  failure_reached: boolean; // true si cayó al 80% Mmax; false = límite del barrido
  material_summary: MaterialSummary;
  section_summary: SectionSummary;
}

export interface MaterialSummary {
  // Concreto no confinado
  fpc_MPa: number;
  epsc0_unconf: number;
  ecu_unconf: number;
  // Concreto confinado (Mander)
  fpcc_MPa: number;
  fcc_sobre_fc: number;
  ke: number;
  fl_MPa: number;
  rho_s_pct: number;
  epsc0_conf: number;
  ecu_conf: number;
  // Acero
  fyh_MPa: number;
  fy_MPa: number;
  eps_y: number;
  nota?: string;
}

export interface SectionSummary {
  forma: string;
  b_mm?: number;
  h_mm?: number;
  D_mm?: number;
  recubrimiento_mm?: number;
  area_bruta_mm2?: number;
  area_acero_mm2?: number;
  rho_t_pct?: number;
  n_barras?: number;
  varilla?: string;
  P_sobre_fcAg?: number;
  P_kN: number;
}
