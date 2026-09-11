// ── Tipos para el Módulo 1 — Constructor de Modelos Estructurales ─────────────

export type StructuralAnalysisType = "import_validate" | "modal" | "spectral" | "design_columns" | "design_beams" | "wall_demands" | "wall_design" | "nl_pushover";
export type StructuralJobStatus    = "pending" | "running" | "success" | "failed" | "cancelled";
export type ValidationStatus       = "not_run" | "has_errors" | "has_warnings" | "ok";

// ── Proyecto ──────────────────────────────────────────────────────────────────

export interface StructuralProject {
  id: string;
  name: string;
  description: string | null;
  parameters_json: SeismicParameters | null;
  input_file_path: string | null;
  e2k_file_path: string | null;
  canonical_model_path: string | null;
  validation_status: ValidationStatus;
  created_at: string;
  updated_at: string;
}

export interface SeismicParameters {
  // Norma
  code: string;

  // Ubicación y amenaza sísmica
  city: string;
  department?: string;
  Aa?: number;        // aceleración pico efectiva NSR-10 (g)
  Av?: number;        // velocidad pico efectiva NSR-10 (g)
  seismic_zone?: string;
  soil_type: string;  // A / B / C / D / E

  // Grupo de uso e importancia
  edification_use: string;    // I / II / III / IV
  importance_factor: number;  // factor I

  // Sistema estructural
  structure_system: string;   // RCMRF / WRCF / DUAL
  energy_dissipation: string; // DMO / DES / DES_ESP
  R?: number;                 // factor de reducción de fuerza sísmica
  Ct?: number;                // coeficiente para período empírico
  alpha_x?: number;           // exponente para período empírico

  // Parámetros de análisis
  damping_ratio: number;       // amortiguamiento (fracción, ej. 0.05)
  n_modes: number;             // número de modos
  combination_method: string;  // CQC / SRSS

  // Patrones de carga en el modelo
  cm_load: string;
  cv_load: string;
}

// ── Job ───────────────────────────────────────────────────────────────────────

export interface StructuralJob {
  id: string;
  celery_task_id: string | null;
  analysis_type: StructuralAnalysisType;
  status: StructuralJobStatus;
  result_path: string | null;
  result_summary: Record<string, unknown> | null;
  error_message: string | null;
  project_id: string;
  created_at: string;
  finished_at: string | null;
}

// ── Combinaciones de diseño NSR-10 B.3.4 ─────────────────────────────────────

export type CombinationGroup = "gravity" | "seismic_x" | "seismic_y";

export interface LoadCombination {
  id: string;               // "G1", "S1", …
  name: string;             // nombre corto
  group: CombinationGroup;
  ref: string;              // "B.3.4-1"
  formula: string;          // "1.4·CM"
  factors: { CM: number; CV: number; Ex: number; Ey: number };
  note: string;
}

export interface CombinationsResult {
  combinations: LoadCombination[];
  selected_ids: string[];
}

// ── Resultado: Validación + Modelo Canónico ───────────────────────────────────

export interface ValidationIssue {
  code: string;
  severity: "critical" | "warning";
  message: string;
  location: string;
  details?: Record<string, unknown>;
}

export interface ModelSummary {
  n_stories: number;
  n_joints: number;
  n_frames: number;
  n_shells: number;
  n_sections: number;
  n_materials: number;
  story_names: string[];
  total_height_m: number;
}

export interface ValidationResult {
  validation_status: ValidationStatus;
  has_critical: boolean;
  n_critical: number;
  n_warnings: number;
  issues: ValidationIssue[];
  model_summary: ModelSummary | null;
  load_patterns?: string[];
}

// ── Geometría del modelo para visualización 3D ───────────────────────────────

export interface JointGeometry {
  x: number;
  y: number;
  z: number;
  story: string;
  is_restrained: boolean;
}

export interface FrameGeometry {
  joint_i: string;
  joint_j: string;
  element_type: "column" | "beam";
  story: string;
  section: string;
}

export interface StoryInfo {
  elevation_m: number;
  height_m: number;
}

export interface StoryMass {
  story: string;
  mass_x_t: number;
  x_cm_m: number;
  y_cm_m: number;
  z_m: number;
}

export interface ModelGeometry {
  joints: Record<string, JointGeometry>;
  frames: Record<string, FrameGeometry>;
  shells: Record<string, ShellSummary>;
  stories: Record<string, StoryInfo>;
  masses: Record<string, StoryMass>;
  load_patterns: string[];
  shell_loads?: Record<string, Record<string, number>>;
  n_joints: number;
  n_frames: number;
  n_shells: number;
  n_stories: number;
}

// ── Resultado: Análisis Modal ─────────────────────────────────────────────────

export interface ModeRow {
  mode: number;
  T: number;
  Ux_pct: number;
  Uy_pct: number;
  Rz_pct: number;
  Ux_cum: number;
  Uy_cum: number;
  Rz_cum: number;
}

export interface ModalViewer {
  nodes: Record<string, [number, number, number]>;
  mode_shapes: Record<string, Record<string, [number, number, number]>>;
  elements: [number, number][];
}

export interface ModalResult {
  num_modes: number;
  num_floors: number;
  T1: number;           // período fundamental (s)
  T1_x: number;         // período traslacional X
  T1_y: number;         // período traslacional Y
  modes_table: ModeRow[];
  viewer: ModalViewer;
}

// ── Resultado: Análisis Espectral RSA + FHE ───────────────────────────────────

export interface SpectrumCurve {
  T: number[];
  Sa: number[];
  Sd: number[];
  Sv: number[];
}

export interface SpectralParams {
  SDs: number;   // aceleración espectral en período corto (g)
  SD1: number;   // aceleración espectral en T=1s (g)
  T0: number;    // período inicio plateau (s)
  Ts: number;    // período fin plateau (s)
  TL: number;    // período largo (s)
  Fa: number;    // factor de amplificación suelo (período corto)
  Fv: number;    // factor de amplificación suelo (período largo)
}

export interface StoryDrift {
  story: string;
  height_m: number;
  drift_x_pct: number;   // deriva inelástica en X (%)
  drift_y_pct: number;   // deriva inelástica en Y (%)
  disp_x_m: number;      // desplazamiento en X (m)
  disp_y_m: number;      // desplazamiento en Y (m)
}

export interface FHEReport {
  W_kN: number;              // peso sísmico total (kN)
  Cs_min: number;            // cortante basal mínimo normalizado (NSR-10 A.4.2.2)
  Cs_used: number;           // Cs efectivo usado
  Vb_modal_x_kN: number;     // cortante basal modal dirección X (sin escalar)
  Vb_modal_y_kN: number;     // cortante basal modal dirección Y (sin escalar)
  Vb_min_x_kN: number;       // cortante mínimo reglamentario X
  Vb_min_y_kN: number;       // cortante mínimo reglamentario Y
  scale_x: number;           // factor de escala aplicado en X (1.0 = sin escala)
  scale_y: number;           // factor de escala aplicado en Y (1.0 = sin escala)
  scaled_x: boolean;         // ¿se escaló la dirección X?
  scaled_y: boolean;         // ¿se escaló la dirección Y?
  Vb_final_x_kN: number;     // cortante basal final escalado X
  Vb_final_y_kN: number;     // cortante basal final escalado Y
}

// ── Espectro preview (endpoint síncrono) ─────────────────────────────────────

export interface SpectrumPreviewPoint {
  T: number;
  Sa: number;
  Sd: number;
  Sv: number;
}

export interface SpectrumPreviewResult {
  params: SpectralParams;
  puntos: SpectrumPreviewPoint[];
  zona_sismica?: string;
}

export interface SpectralResult {
  spectrum: SpectrumCurve;
  spectral_params: SpectralParams;
  story_drifts: StoryDrift[];
  story_forces_x: Record<string, number>;   // kN por piso
  story_forces_y: Record<string, number>;
  story_shears_x: Record<string, number>;   // kN por piso (acumulado)
  story_shears_y: Record<string, number>;
  fhe: FHEReport;
  combination_method: string;
  n_modes_used: number;
  mass_participation_x: number;   // % masa efectiva X acumulada
  mass_participation_y: number;   // % masa efectiva Y acumulada
}

// ── Resultado: Diseño de columnas NSR-10 B.3.4 ───────────────────────────────

export interface ColumnCheckRow {
  id: string;           // frame ID del modelo
  story: string;
  section: string;      // nombre de sección ETABS
  b_m: number;
  h_m: number;
  fc_MPa: number;
  Pu_kN: number;        // axial de diseño (envolvente combinaciones)
  Mu_kNm: number;       // momento de diseño (envolvente combinaciones)
  combo: string;        // combinación gobernante
  phi_Pn_kN: number;    // φPn_max (compresión pura)
  phi_Mn_kNm: number;   // φMn (flexión pura)
  Ag_m2: number;
  Ast_cm2: number;
  rho_pct: number;
  dcr: number;
  ok: boolean;
  Mu_cap_kNm: number;
}

// ── Resultado: Diseño de vigas NSR-10 ─────────────────────────────────────────

export interface BeamCheckRow {
  id: string;
  story: string;
  section: string;
  b_m: number;
  h_m: number;
  L_m: number;
  fc_MPa: number;
  w_kNm: number;
  combo: string;
  // Demandas
  Mu_neg_kNm: number;
  Mu_pos_kNm: number;
  Vu_kN: number;
  // Flexión
  As_neg_cm2: number;
  As_pos_cm2: number;
  As_min_cm2: number;
  As_max_cm2: number;
  phi_Mn_kNm: number;
  rho: number;
  dcr_flex: number;
  ok_flex: boolean;
  section_fail: boolean;
  // Cortante
  phi_Vc_kN: number;
  phi_Vs_kN: number;
  phi_Vn_kN: number;
  s_mm: number;
  Av_cm2_m: number;
  dcr_shear: number;
  ok_shear: boolean;
  // Global
  dcr: number;
  ok: boolean;
}

export interface BeamDesignResult {
  n_beams: number;
  n_ok: number;
  n_ng: number;
  max_dcr: number;
  fy_MPa: number;
  stirrup_bar: string;
  n_combinations: number;
  beams: BeamCheckRow[];
  notes: string[];
}

export interface ColumnDesignResult {
  n_columns: number;
  n_ok: number;
  n_ng: number;
  max_dcr: number;
  rho_assumed: number;
  fy_MPa: number;
  n_combinations: number;
  columns: ColumnCheckRow[];
  notes: string[];
}

// ── Tipos para el detalle de diseño (Módulo 1 v2) ────────────────────────────

export type FrameStatus = "ok" | "warning" | "ng" | "user_modified" | "pending";

export interface FrameListItem {
  frame_id: string;
  story: string;
  element_type: "column" | "beam";
  section: string;
  dcr: number;
  ok: boolean;
  has_detail: boolean;
  user_modified: boolean;
  status: FrameStatus;
}

export interface FrameListResult {
  frames: FrameListItem[];
  story_order: string[];
  n_columns: number;
  n_beams: number;
  n_ok: number;
  n_ng: number;
}

// ── Barras de refuerzo ────────────────────────────────────────────────────────

export interface BarPosition {
  x: number;   // mm desde centroide de sección
  y: number;   // mm desde centroide de sección
}

export interface LongitudinalBars {
  n_bars: number;
  bar_label: string;
  diam_mm: number;
  As_req_cm2: number;
  As_placed_cm2: number;
  rho_pct?: number;
  bar_positions: BarPosition[];
  warnings: string[];
  errors: string[];
  valid: boolean;
}

export interface TransverseBars {
  tie_bar_label: string;
  tie_diam_mm: number;
  n_legs_b: number;
  n_legs_h: number;
  s_confined_mm: number;
  s_general_mm: number;
  L_confinement_mm: number;
  phi_Vc_kN: number;
  energy_dissipation: string;
  warnings: string[];
}

// ── Detalle columna ───────────────────────────────────────────────────────────

export interface ColumnDemandCombo {
  combo_id: string;
  Pu_kN: number;
  Mu2_kNm: number;
  Mu3_kNm: number;
  Mu_res_kNm: number;
  Vu2_kN: number;
  Vu3_kN: number;
}

export interface ColumnDemandGoverning {
  Pu_kN: number;
  Mu2_kNm: number;
  Mu3_kNm: number;
  Mu_res_kNm: number;
  Vu2_kN: number;
  Vu3_kN: number;
  combo: string;
}

export interface PMCurveData {
  P_kN: number[];
  M_kNm: number[];
}

export interface ColumnCheck {
  ok: boolean;
  dcr?: number;
  ref: string;
  [key: string]: unknown;
}

export interface ColumnDesignDetail {
  frame_id: string;
  story: string;
  section: string;
  element_type: "column";
  geometry: {
    b_m: number;
    h_m: number;
    L_m: number;
    fc_MPa: number;
    fy_MPa: number;
    cover_m: number;
    Ag_cm2: number;
  };
  demands: {
    governing: ColumnDemandGoverning;
    by_combination: ColumnDemandCombo[];
  };
  required_reinforcement: {
    As_long_cm2: number;
    rho_req_pct: number;
  };
  proposed_reinforcement: {
    longitudinal: LongitudinalBars;
    transverse: TransverseBars;
  };
  final_reinforcement: {
    reinforcement: {
      longitudinal?: { n_bars: number; bar_label: string };
      transverse?: { tie_bar_label: string; s_confined_mm: number; s_general_mm: number };
    };
    notes?: string;
    saved_at?: string;
  } | null;
  user_modified: boolean;
  checks: Record<string, ColumnCheck>;
  overall_ok: boolean;
  max_dcr: number;
  pm_curve: PMCurveData;
  capacity: {
    phi_Pn_max_kN: number;
    phi_Mn_kNm: number;
    phi_Pb_kN: number;
    phi_Mb_kNm: number;
    phi_Pt_kN: number;
    dcr: number;
    ok: boolean;
  };
  warnings: string[];
  errors: string[];
}

// ── Detalle viga ──────────────────────────────────────────────────────────────

export type BeamClassification = "seismic_primary" | "secondary";
export type BeamDesignStatus = "OK" | "WARNING" | "SECTION_INSUFFICIENT" | "DESIGN_ERROR" | "GOVERNED_BY_ASMIN";
export type SeismicParticipation = "sismorresistente" | "gravitacional";

export interface BeamZoneDemand {
  Mu_neg_kNm: number;
  Mu_pos_kNm: number;
  Mu_kNm?: number;
  combo: string;
  As_req_cm2: number;
  As_min_cm2: number;
  As_max_cm2: number;
  phi_Mn_kNm: number;
  d_eff_mm?: number;
  dcr_flex: number;
  ok_flex: boolean;
  section_fail?: boolean;
  design_status?: BeamDesignStatus;
}

export interface BeamZoneVerify {
  phi_Mn_kNm: number;
  d_eff_mm: number;
  dcr: number;
  ok: boolean;
  at_max_steel?: boolean;
}

export interface BeamZoneBars {
  top: LongitudinalBars;
  bot: LongitudinalBars;
  As_top_req_cm2: number;
  As_bot_req_cm2: number;
  verify_top?: BeamZoneVerify;
  verify_bot?: BeamZoneVerify;
}

export interface BeamShearZone {
  s_mm: number;
  L_mm?: number;
  phi_Vn_kN: number;
  dcr: number;
  ok: boolean;
}

export interface BeamShearDesign {
  tie_bar_label: string;
  tie_diam_mm: number;
  n_legs: number;
  phi_Vc_kN: number;
  zone_end: BeamShearZone;
  zone_mid: BeamShearZone;
  Vu_end_kN: number;
  Vu_mid_kN: number;
}

export interface BeamProposedReinforcement {
  top_continuous:  { label: string; n_bars: number; bar_label: string; As_cm2: number };
  top_extra_i:     { label: string; n_bars: number; bar_label: string; As_cm2: number; L_m: number };
  top_extra_j:     { label: string; n_bars: number; bar_label: string; As_cm2: number; L_m: number };
  bot_continuous:  { label: string; n_bars: number; bar_label: string; As_cm2: number };
  stirrups: {
    zone_end: { bar_label: string; n_legs: number; s_mm: number; L_m: number };
    zone_mid: { bar_label: string; n_legs: number; s_mm: number };
  };
}

export interface BeamDesignDetail {
  frame_id: string;
  story: string;
  section: string;
  element_type: "beam";
  classification: BeamClassification;
  seismic_participation: SeismicParticipation;
  design_status: BeamDesignStatus;
  combinations_used: string[];
  geometry: {
    b_m: number;
    h_m: number;
    L_m: number;
    fc_MPa: number;
    fy_MPa: number;
    cover_m: number;
    b_cm: number;
    h_cm: number;
  };
  demands: {
    by_zone: Record<string, BeamZoneDemand>;
    by_combination: Array<{ combo_id: string; Mu_neg_kNm: number; Mu_pos_kNm: number; Vu_kN: number }>;
    Vu_end_kN: number;
    Vu_mid_kN: number;
  };
  reinforcement_by_zone: Record<string, BeamZoneBars>;
  proposed_reinforcement: BeamProposedReinforcement;
  shear_design: BeamShearDesign;
  final_reinforcement: {
    reinforcement: {
      top_bars?: { n_bars: number; bar_label: string };
      bot_bars?: { n_bars: number; bar_label: string };
      stirrups?: {
        zone_end: { bar_label: string; n_legs: number; s_mm: number };
        zone_mid: { bar_label: string; n_legs: number; s_mm: number };
      };
    };
    notes?: string;
    saved_at?: string;
  } | null;
  user_modified: boolean;
  checks: Record<string, { ok: boolean; dcr?: number; ref: string; [key: string]: unknown }>;
  overall_ok: boolean;
  max_dcr: number;
  warnings: string[];
  errors: string[];
}

// ── Tipos para edición manual ─────────────────────────────────────────────────

export interface ColumnReinforcementEdit {
  longitudinal: { n_bars: number; bar_label: string };
  transverse?: { tie_bar_label: string; s_confined_mm: number; s_general_mm: number };
}

export interface BeamReinforcementEdit {
  top_bars: { n_bars: number; bar_label: string };
  bot_bars: { n_bars: number; bar_label: string };
  stirrups?: {
    zone_end: { bar_label: string; n_legs: number; s_mm: number };
    zone_mid: { bar_label: string; n_legs: number; s_mm: number };
  };
}

// ── Tipos para el editor interactivo del modelo (Módulo 1 v3) ─────────────────

/** Datos de una sección de marco en el modelo canónico. */
export interface SectionData {
  material: string;
  shape: string;
  h_m: number;
  b_m: number;
  A_m2: number;
  I33_m4: number;
  I22_m4: number;
  J_m4: number;
  E_mpa: number;
  G_mpa: number;
}

/** Datos de un material en el modelo canónico. */
export interface MaterialData {
  type: "concrete" | "steel";
  fpc_mpa: number;    // f'c para concreto (MPa)
  fy_mpa?: number;    // fy para acero (MPa)
  E_mpa: number;
  G_mpa: number;
}

/** Frame resumido para el editor (sin coordenadas de nodos). */
export interface FrameSummary {
  joint_i: string;
  joint_j: string;
  section: string;
  element_type: "column" | "beam";
  story: string;
  object_label?: string;
}

/** Shell resumido para el editor y el visor. */
export interface ShellSummary {
  joints: string[];
  section: string;
  element_type: "wall" | "slab";
  story: string;
  thickness_m: number;
  pier?: string;
}

/** Modelo canónico completo retornado por /model-data (sin analysis_results). */
export interface FullModelData {
  schema_version: string;
  metadata: {
    n_stories: number;
    n_joints: number;
    n_frames: number;
    n_shells: number;
    n_sections: number;
    n_materials: number;
    story_names: string[];
    total_height_m: number;
    load_patterns: string[];
  };
  stories: Record<string, { elevation_m: number; height_m: number }>;
  joints: Record<string, { x: number; y: number; z: number; story: string; is_restrained: boolean }>;
  restraints: Record<string, number[]>;
  sections: Record<string, SectionData>;
  materials: Record<string, MaterialData>;
  frames: Record<string, FrameSummary>;
  shells: Record<string, ShellSummary>;
  masses: Record<string, { story: string; mass_x_t: number; mass_y_t: number; z_m: number }>;
}

/** Resultado del health check del modelo. */
export interface ModelCheckResult {
  geometry_ok: boolean;
  connectivity_ok: boolean;
  materials_ok: boolean;
  sections_ok: boolean;
  loads_ok: boolean;
  n_frames_no_section: number;
  n_sections_no_material: number;
  n_undefined_sections: number;
  n_zero_length: number;
  n_isolated_nodes: number;
  n_columns: number;
  n_beams: number;
  n_walls: number;
  n_slabs: number;
  warnings: ModelCheckIssue[];
  errors: ModelCheckIssue[];
  ready_for_analysis: boolean;
  n_errors: number;
  n_warnings: number;
}

export interface ModelCheckIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  count: number;
  element_ids?: string[];
  items?: string[];
}

/** Info de elemento para el inspector de propiedades. */
export interface ElementClickInfo {
  id: string;
  element_type: "column" | "beam" | "wall" | "slab";
  story: string;
  section: string;
  object_label?: string;
}

/** Acción de undo para asignación de sección (guardada en el cliente). */
export interface UndoAssignSection {
  type: "assign_section";
  previous_sections: Record<string, string>;  // frameId → sectionName anterior
  new_section: string;
  frame_ids: string[];
}

/** Resultado de la asignación de sección. */
export interface AssignSectionResult {
  ok: boolean;
  section_assigned: string;
  n_updated: number;
  n_not_found: number;
  updated_ids: string[];
  previous_sections: Record<string, string>;
}

// ── Modelo No Lineal ──────────────────────────────────────────────────────────

export type NLSpecStatus = "missing" | "current" | "stale";

export interface NLSpecMetadata {
  project_id:          string;
  generated_at:        string;
  source_digest:       string;
  n_stories:           number;
  n_columns:           number;
  n_beams:             number;
  n_columns_designed:  number;
  n_beams_designed:    number;
  energy_dissipation:  string;
  structure_system:    string;
  units:               string;
}

export interface NLSpecValidation {
  n_columns_no_design: number;
  n_beams_no_design:   number;
  n_warnings:          number;
  ready_for_analysis:  boolean;
  warnings:            string[];
}

export interface NLSpecStatusResult {
  status:     NLSpecStatus;
  metadata:   NLSpecMetadata | null;
  validation: NLSpecValidation | null;
}

export interface NLSpecGenerateResult {
  ok:         boolean;
  message:    string;
  metadata:   NLSpecMetadata;
  validation: NLSpecValidation;
}

/** Modo de color del viewport 3D. */
export type ColorMode = "type" | "section" | "story";

/** Filtros de visibilidad del viewport. */
export interface ViewerTypeFilter {
  columns: boolean;
  beams: boolean;
  walls: boolean;
  slabs: boolean;
}

// ── Tipos para demandas de muros (FHE NSR-10 + MVLEM_3D) ────────────────────

export interface WallFHEParams {
  hn_m:  number;
  T_s:   number;
  Cs:    number;
  W_kN:  number;
  Vb_kN: number;
}

export interface WallPierDemand {
  pier:       string;
  story:      string;
  combo:      string;
  Pu_kN:      number;
  Vu_x_kN:   number;
  Vu_y_kN:   number;
  Mu_x_kNm:  number;
  Mu_y_kNm:  number;
  lw_m:       number;
  tw_m:       number;
  hw_m:       number;
}

export interface WallDemandsResult {
  status:       string;
  job_id:       string;
  project_id:   string;
  fhe_params:   WallFHEParams;
  story_forces: { X: Record<string, number>; Y: Record<string, number> };
  gravity_axials: Record<string, number>;
  pier_demands: WallPierDemand[];
  pier_count:   number;
  story_count:  number;
}

// ── Tipos para diseño de muros (NSR-10 C.21) ──────────────────────────────────

export interface WallDesignRow {
  pier:            string;
  story:           string;
  lw_m:            number;
  tw_m:            number;
  hw_m:            number;
  ok:              boolean;
  n_failed:        number;
  max_dcr:         number;
  ebe_required:    boolean;
  ebe_method:      string;      // "stress" | "displacement"
  lc_m:            number;
  c_m:             number;
  phi_Mn_kNm:      number;
  phi_Vn_kN:       number;
  Vu_kN:           number;
  governing_combo: string;
  web_horiz_db_mm: number;
  web_horiz_sp_mm: number;
  web_vert_db_mm:  number;
  web_vert_sp_mm:  number;
  rho_h_pct:       number;
  rho_v_pct:       number;
  be_n_bars:       number;
  be_db_mm:        number;
  be_lc_m:         number;
  error?:          string;
}

export interface WallDesignResult {
  status:      string;
  job_id:      string;
  project_id:  string;
  fc_mpa:      number;
  fy_mpa:      number;
  ductility:   string;
  pier_count:  number;
  n_ok:        number;
  n_ng:        number;
  n_ebe:       number;
  max_dcr:     number;
  ebe_method:  string;
  designs:     WallDesignRow[];
}

// ── Pushover no lineal (Módulo 1 — muros) ────────────────────────────────────

export interface NLPushoverStep {
  step:           number;
  displacement_m: number;
  drift_pct:      number;
  base_shear_kN:  number;
}

export interface NLPushoverDirResult {
  status:           string;
  direction:        string;
  converged_steps:  number;
  total_steps:      number;
  target_drift_pct: number;
  steps:            NLPushoverStep[];
  summary: {
    max_drift_pct:       number;
    max_base_shear_kN:   number;
    last_displacement_m: number;
  };
}

export interface NLPushoverResult {
  status:            string;
  job_id:            string;
  project_id:        string;
  fc_mpa:            number;
  fy_mpa:            number;
  target_drift_pct:  number;
  n_fibers:          number;
  summary:           Record<string, { status: string; max_drift_pct: number; max_base_shear_kN: number; converged_steps: number; total_steps: number }>;
  pushover_X?:       NLPushoverDirResult;
  pushover_Y?:       NLPushoverDirResult;
  computed_at:       string;
}
