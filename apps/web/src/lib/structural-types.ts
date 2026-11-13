// ── Tipos para el Módulo 1 — Constructor de Modelos Estructurales ─────────────

export type StructuralAnalysisType = "import_validate" | "modal" | "spectral" | "design_columns" | "design_beams" | "wall_demands" | "wall_design" | "nl_pushover" | "variant_pushover" | "frame_pushover" | "nlth";
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
  /** Progreso en vivo publicado por tasks largos. Formato típico:
   *  {stage, direction, step, total, pct, drift_pct, base_shear_kN}
   */
  progress?: {
    stage?:         "init" | "gravity" | "pushover" | "done" | string;
    direction?:     string;
    pattern_type?:  string;
    step?:          number;
    total?:         number;
    pct?:           number;
    drift_pct?:     number;
    base_shear_kN?: number;
  } | null;
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
  object_label?: string;
  release?: string;
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

export type ReinforcementSource = "bulk" | "manual" | null;

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
  /** "bulk" | "manual" | null. Null = sin refuerzo custom aún. */
  source?: ReinforcementSource;
  pattern_label?: string | null;
  bulk_batch_id?: string | null;
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

// ── Refuerzo por sección (as-built) — Módulo 1, F1/F2 reinforcement ─────────

export interface ColumnBarGroup {
  bar_label: string;
  n_bars:    number;
  db_mm?:    number;
  As_cm2?:   number;
}
export interface ColumnBarGroups {
  corners:    ColumnBarGroup;   // siempre 4 barras
  top_face:   ColumnBarGroup;
  bot_face:   ColumnBarGroup;
  left_face:  ColumnBarGroup;
  right_face: ColumnBarGroup;
}
export interface ColumnReinfLongitudinal {
  // Resumen (opcional en entrada — el backend lo calcula si viene granular)
  n_bars?:    number;
  bar_label?: string;      // dominante
  As_cm2?:    number;
  // Nuevo modelo granular
  groups?:    ColumnBarGroups;
}
export interface ColumnReinfTransverse {
  tie_bar_label:      string;
  n_legs_b:           number;
  n_legs_h:           number;
  s_confined_mm:      number;
  s_general_mm:       number;
  L_confinement_mm?:  number;
}
export interface BeamZoneBarsAsBuilt {
  top: { n_bars: number; bar_label: string; As_cm2: number };
  bot: { n_bars: number; bar_label: string; As_cm2: number };
}
export interface BeamZones {
  end_i: BeamZoneBarsAsBuilt;
  mid:   BeamZoneBarsAsBuilt;
  end_j: BeamZoneBarsAsBuilt;
}
export interface BeamShear {
  tie_bar_label:      string;
  n_legs:             number;
  s_confined_mm:      number;
  s_central_mm:       number;
  L_confinement_mm?:  number;
}

export interface SectionPatternColumn {
  mode:          "manual";
  section_name:  string;
  element_type:  "column";
  longitudinal:  ColumnReinfLongitudinal;
  transverse:    ColumnReinfTransverse;
  pattern_label: string | null;
  notes:         string | null;
  updated_at:    string;
}
export interface SectionPatternBeam {
  mode:          "manual";
  section_name:  string;
  element_type:  "beam";
  zones:         BeamZones;
  shear:         BeamShear;
  pattern_label: string | null;
  notes:         string | null;
  updated_at:    string;
}
export type SectionPattern = SectionPatternColumn | SectionPatternBeam;

export interface SectionReinforcementItem {
  section_key:   string;             // "column:C40x40" | "beam:V30x40"
  section_name:  string;
  element_type:  "column" | "beam";
  b_m:           number;
  h_m:           number;
  material:      string;
  fc_MPa:        number;
  fy_MPa:        number;
  cover_m:       number;
  frame_ids:     string[];
  stories:       string[];
  n_elements:    number;
  mode:          "auto" | "manual";
  pattern:       SectionPattern | null;
  pattern_label: string | null;
  updated_at:    string | null;
  n_overrides:   number;
}

export interface SectionReinforcementList {
  sections:  SectionReinforcementItem[];
  n_total:   number;
  n_manual:  number;
  n_auto:    number;
}

export interface ReinforcementNSR10Warning {
  level:   "info" | "warning" | "error";
  code:    string;
  message: string;
}
export interface ReinforcementNSR10Result {
  warnings:    ReinforcementNSR10Warning[];
  n_errors:    number;
  n_warnings:  number;
  n_info:      number;
  nsr10_ok:    boolean;
  section_key: string;
}

export interface SaveSectionReinforcementPayload {
  mode:          "manual";
  pattern_label?: string | null;
  notes?:        string | null;
  // columna
  longitudinal?: ColumnReinfLongitudinal;
  transverse?:   ColumnReinfTransverse;
  // viga
  zones?:        BeamZones;
  shear?:        BeamShear;
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
  is_planar?: boolean;
  out_of_plane_m?: number;
}

// ── Grid, Mampostería, Infills ────────────────────────────────────────────────

export interface GridAxis {
  name: string;
  coord_m: number;
}

export interface StoryDef {
  name: string;
  height_m: number;
}

export interface GridDefinition {
  axes_x: GridAxis[];
  axes_y: GridAxis[];
  stories: StoryDef[];
}

export type MasonryBrickType = "VP" | "HP" | "custom";

export interface MasonryMaterial {
  id: string;
  name: string;
  fm_mpa: number;
  brick_type: MasonryBrickType;
  Em_mpa: number;
}

export interface InfillPanel {
  id: string;
  column_i_fid?: string;   // fid de columna izquierda (canonical.frames)
  column_j_fid?: string;   // fid de columna derecha
  pier?: string;           // legacy — etiqueta descriptiva opcional
  story: string;
  thickness_m: number;
  masonry_material_id: string;
  opening_ratio: number;   // 0 = sin abertura, 1 = totalmente abierta
  width_ratio: number;     // Mainstone simplificado, default 0.25
}

// ── Herramienta de dibujo ────────────────────────────────────────────────────

export type DrawingTool =
  | "select"
  | "column"
  | "beam"
  | "wall"
  | "slab"
  | "infill";

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
  grid?: GridDefinition;
  masonryMaterials?: Record<string, MasonryMaterial>;
  infills?: Record<string, InfillPanel>;
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
  hn_m:   number;
  W_kN:   number;
  Vb_kN:  number;
  /** "FHE" (interno) o "RSA" (vino de spectral_results.json). */
  source?: string;
  /** Solo definidos cuando source=FHE (el modo RSA no calcula T ni Cs). */
  T_s?:   number;
  Cs?:    number;
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
  summary:           Record<string, { status: string; max_drift_pct: number; max_base_shear_kN: number; converged_steps: number; total_steps: number; n_critical_piers?: number; max_di?: number }>;
  pushover_X?:       NLPushoverDirResult;
  pushover_Y?:       NLPushoverDirResult;
  computed_at:       string;
}

// ── Historia de deformada para animación 3D ──────────────────────────────────

export type DamageLevel = "none" | "minor" | "moderate" | "severe" | "collapse";

export interface PierLineDeformable {
  pier:       string;
  story:      string;
  story_idx:  number;
  coords_ref: {
    base_left:  [number, number, number];
    base_right: [number, number, number];
    top_right:  [number, number, number];
    top_left:   [number, number, number];
  };
  node_tags: {
    base_left:  number;
    base_right: number;
    top_right:  number;
    top_left:   number;
  };
  lw_m: number;
  tw_m: number;
  hw_m: number;
  damage: {
    di:          number;
    di_base:     number;
    level:       DamageLevel;
    drift_pct:   number;
  };
}

export interface NLPushoverFrame {
  frame:          number;
  step:           number;
  drift_pct:      number;
  base_shear_kN:  number;
  disp:           Record<string, [number, number, number]>;
}

export interface StoryDrift {
  story:         string;
  z_m:           number;
  max_drift_pct: number;
}

export interface NLPushoverHistory {
  direction:        string;
  total_height_m:   number;
  target_drift_pct: number;
  drift_cap:        number;
  n_frames:         number;
  n_captured:       number;
  n_total_steps:    number;
  stride:           number;
  frames:           NLPushoverFrame[];
  pier_lines:       PierLineDeformable[];
  story_drifts:     StoryDrift[];
  summary?: {
    max_drift_pct:       number;
    max_base_shear_kN:   number;
    last_displacement_m: number;
  };
}

// ── Respuesta local por pier (M-φ y V-δ) ─────────────────────────────────────

export interface MPhiPoint {
  step:         number;
  phi_1_per_m:  number;
  moment_kNm:   number;
  drift_pct:    number;
}

export interface VDeltaPoint {
  step:       number;
  delta_m:    number;
  shear_kN:   number;
  drift_pct:  number;
}

// ── Pushover no lineal de pórticos (Módulo 1 — F2-F6) ────────────────────────

export type HingeDamageLevel = "none" | "near_io" | "io" | "ls" | "cp" | "collapse";
export type PushoverPatternType = "triangular" | "uniforme" | "modal";

export interface HingeRecord {
  fid:             string;
  kind:            "column" | "beam";
  story:           string;
  end:             "i" | "j";
  ele_tag:         number;
  node_tag:        number;
  theta_p_max:     number;
  theta_y:         number;
  theta_IO:        number;
  theta_LS:        number;
  theta_CP:        number;
  /** Capacidades base ASCE 41-17 (sin aplicar k_conf). */
  theta_IO_base?:  number;
  theta_LS_base?:  number;
  theta_CP_base?:  number;
  /** Factor por confinamiento Mander aplicado a la capacidad base. */
  k_conf?:         number;
  rho_s?:          number;
  damage_level:    HingeDamageLevel;
  dcr:             number;
  step_first_IO:   number | null;
  step_first_LS:   number | null;
  step_first_CP:   number | null;
  /** Serie θ_p submuestreada alineada con `frames` del endpoint history. */
  theta_p_hist?:   number[];
}

/** Umbrales ajustables de daño separados por tipo.
 *  - beam/column: rotación plástica θ_p (rad).
 *  - infill: deriva relativa del panel (fracción adimensional).
 */
export interface HingeThresholds {
  beam:   { IO: number; LS: number; CP: number };
  column: { IO: number; LS: number; CP: number };
  infill: { IO: number; LS: number; CP: number };
  /** Si true, se aplica el factor k_conf de cada rótula a la capacidad base. */
  applyKConf: boolean;
}

export interface ElementLine {
  fid:         string;
  kind:        "column" | "beam";
  story:       string;
  ele_tag:     number;
  node_i:      number;
  node_j:      number;
  node_i_lbl:  string;
  node_j_lbl:  string;
  b_m:         number;
  h_m:         number;
  L_m:         number;
  lp_m:        number;
}

// ── Eventos locales (Bloque B): fluencia, aplastamiento, pandeo, fractura ────

export type LocalEventType =
  | "first_yield_bar"
  | "cover_crush"
  | "core_crush"
  | "bar_buckling"
  | "bar_fracture";

export interface LocalEvent {
  fid:       string;
  kind:      "column" | "beam";
  story:     string;
  step:      number;
  time_s:    number | null;
  type:      LocalEventType;
  location:  "end_i" | "end_j";
  strain:    number;
  threshold: number;
  direction: string | null;
}

export interface LocalEventsPayload {
  status:  "success" | "no_sect_def_captured" | "failed" | string;
  message?: string;
  events:  LocalEvent[];
  summary: Record<LocalEventType, number>;
  /** Overrides globales enviados por el usuario en el último recálculo. */
  thresholds_user_override?: Partial<Record<ThresholdKey, number>>;
  /** Defaults del motor (ε_sy, ε_cu_cover, ε_cu_core, ε_su, ε_bk). */
  thresholds_defaults?: Record<ThresholdKey, number>;
  /** Rango min/max observado por elemento para los umbrales que varían. */
  thresholds_observed?: Partial<Record<ThresholdKey, ThresholdStats>>;
}

export type ThresholdKey =
  | "eps_sy" | "eps_cu_cover" | "eps_cu_core" | "eps_su" | "eps_bk";

export interface ThresholdStats {
  min:  number;
  max:  number;
  mean: number;
  n:    number;
}

export interface NLTHThresholdsMeta {
  defaults:            Record<ThresholdKey, number>;
  observed:            Partial<Record<ThresholdKey, ThresholdStats>>;
  user_override:       Partial<Record<ThresholdKey, number>>;
  n_elements_detected: number;
}

export interface NLFramePushoverDirResult {
  status:           string;
  direction:        string;
  pattern_type:     PushoverPatternType;
  converged_steps:  number;
  total_steps:      number;
  target_drift_pct: number;
  steps:            NLPushoverStep[];
  summary: {
    max_drift_pct:       number;
    max_base_shear_kN:   number;
    last_displacement_m: number;
  };
  /** Diagnóstico de salud del solver (Ola 2 2026-11-04). */
  health?: AnalysisHealth;
  history?: {
    captured_steps: number;
    stride:         number;
    n_joints:       number;
    n_cm:           number;
    n_columns:      number;
    n_beams:        number;
  };
  element_lines?: ElementLine[];
  stories_z?:     Record<string, number>;
  total_height?:  number;
  events?:        LocalEventsPayload;
  damage?: {
    status:     string;
    n_total:    number;
    n_critical: number;
    max_dcr:    number;
    max_level:  HingeDamageLevel;
    hinges:     HingeRecord[];
    by_element: Record<string, {
      fid:       string;
      kind:      "column" | "beam";
      story:     string;
      max_dcr:   number;
      max_level: HingeDamageLevel;
      end_i?:    HingeRecord;
      end_j?:    HingeRecord;
    }>;
  };
}

export interface NLFramePushoverResult {
  status:            string;
  job_id:            string;
  project_id:        string;
  pattern_type:      PushoverPatternType;
  target_drift_pct:  number;
  n_integration_pts: number;
  summary: Record<string, {
    status:             string;
    pattern_type:       PushoverPatternType;
    max_drift_pct:      number;
    max_base_shear_kN:  number;
    converged_steps:    number;
    total_steps:        number;
    n_critical_hinges?: number;
    max_dcr?:           number;
  }>;
  pushover_X?:   NLFramePushoverDirResult;
  pushover_Y?:   NLFramePushoverDirResult;
  computed_at:   string;
}

export interface InfillLine {
  panel_id:          string;
  story:             string;
  nodes:             { bl: number; tl: number; br: number; tr: number };
  coords:            { bl: [number, number, number];
                       tl: [number, number, number];
                       br: [number, number, number];
                       tr: [number, number, number] };
  L_m:               number;
  H_m:               number;
  thickness_m:       number;
  effective_width_m: number;
  area_effective_m2: number;
  lambda_openings:   number;
  material_id:       string;
  ele_tags:          number[];
}

export type InfillDamageLevel = "none" | "cracking" | "degrading" | "collapse";

export interface InfillDamagePanel {
  panel_id:            string;
  story:               string;
  max_damage:          number;
  max_level:           InfillDamageLevel;
  step_first_cracking: number;
  step_first_collapse: number;
  max_strain:          number;
  max_elong_m:         number;
}

export interface InfillDamageHistory {
  status:      "success" | "no_infills" | "no_data";
  n_total:     number;
  n_collapsed: number;
  n_degrading: number;
  max_damage:  number;
  panel_ids:   string[];
  panels:      InfillDamagePanel[];
  /** matriz [n_frames, n_panels] con damage index 0..1 por paso submuestreado */
  history:     number[][];
}

// ── Clasificación de modo de falla por columna (ASCE 41 × hinges NLTHA) ────
export type FailureCategory =
  | "shear_failed"       // predicción cortante + plastificó
  | "flexure_shear_risk" // predicción mixta + plastificó
  | "flexural_ductile"   // predicción flexión + plastificó
  | "no_damage";

export interface FailureModeElement {
  fid:             string;
  kind:            "column";
  story:           string;
  section:         string;
  asce_prediction: "flexion" | "flexion_cortante" | "cortante";
  asce_condition:  "i" | "ii" | "iii" | "iv";
  Vp_kN:           number;
  Vn_kN:           number;
  Vp_over_Vn:      number;
  flags:           string[];
  observed_hinge:  "none" | "near_io" | "io" | "ls" | "cp" | "collapse";
  max_dcr:         number;
  category:        FailureCategory;
  needs_marker:    boolean;
  marker_symbol:   "lightning" | "cross" | "";
}

export interface FailureModesClassification {
  status:   string;
  scheme:   string;
  n_total:  number;
  counts:   Record<FailureCategory, number>;
  elements: FailureModeElement[];
}

/** Daño de mampostería por deriva de entrepiso (FEMA 356 C7-1 / HAZUS). */
export interface InfillDamageByDriftPanel {
  panel_id:            string;
  story:               string;
  orientation:         "X" | "Y";
  story_idx:           number;
  max_drift_pct:       number;
  max_level:           InfillDamageLevel;
  step_first_cracking: number;
  step_first_collapse: number;
}

export interface InfillDamageByDrift {
  status:         "success" | "no_infills" | "no_data" | "no_stories_z" | "failed";
  message?:       string;
  scheme?:        string;
  thresholds?:    { cracking: number; degrading: number; collapse: number };
  n_total:        number;
  n_collapsed:    number;
  n_degrading:    number;
  max_drift_pct:  number;
  panel_ids:      string[];
  panels:         InfillDamageByDriftPanel[];
  /** matriz [n_frames, n_panels] con deriva (fracción) por paso. */
  history:        number[][];
}

export interface NLFramePushoverHistory {
  direction:         string;
  total_height_m:    number;
  target_drift_pct:  number;
  pattern_type:      PushoverPatternType;
  n_frames:          number;
  n_captured:        number;
  n_total_steps:     number;
  stride:            number;
  frames:            NLPushoverFrame[];
  joints_ref:        Record<string, [number, number, number]>;
  stories_z?:        Record<string, number>;
  element_lines:     ElementLine[];
  infill_lines?:     InfillLine[];
  hinge_damage:      HingeRecord[];
  damage_by_element: Record<string, {
    fid:       string;
    kind:      "column" | "beam";
    story:     string;
    max_dcr:   number;
    max_level: HingeDamageLevel;
    end_i?:    HingeRecord;
    end_j?:    HingeRecord;
  }>;
  infill_damage?:    InfillDamageHistory;
  summary?: {
    max_drift_pct:       number;
    max_base_shear_kN:   number;
    last_displacement_m: number;
  };
}

export interface FrameElementResponsePoint {
  step:            number;
  kappa_1_per_m:   number;
  eps_axial:       number;
  drift_pct:       number;
  base_shear_kN:   number;
}

export interface FrameElementResponse {
  fid:    string;
  end:    "i" | "j";
  kind:   "column" | "beam";
  story:  string;
  lp_m:   number;
  b_m:    number;
  h_m:    number;
  L_m:    number;
  curve:  FrameElementResponsePoint[];
  hinge:  HingeRecord | null;
}

// ── Método N2 (Fajfar 2000) — punto de desempeño ─────────────────────────────

export interface N2Result {
  status:     "success" | "collapse";
  project_id: string;
  direction:  "X" | "Y";
  spectrum: {
    source:    string;
    params:    Record<string, number>;
    zona?:     string;
    I_factor:  number;
    T:         number[];
    Sa_mps2:   number[];
    Sd_m:      number[];
  };
  sdof: {
    gamma_1:              number;
    m_ast_ton:            number;
    T_star:               number;
    K_star:               number;
    Say_mps2:             number;
    Sdy_m:                number;
    Sa_max_mps2:          number;
    Sd_ultimo_m:          number;
    idx_falla:            number;
    strength_drop_found:  boolean;
    Tc:                   number;
    Sae_mps2:             number;
    Sde_m:                number;
    R_mu:                 number;
    rule:                 "equal_displacement" | "equal_energy";
    Sd_target_m:          number;
    ductility:            number;
    is_collapse:          boolean;
  };
  capacity: {
    Sd_m:            number[];
    Sa_mps2:         number[];
    Sd_useful_m:     number[];
    Sa_useful_mps2:  number[];
    Sd_degraded_m:   number[];
    Sa_degraded_mps2:number[];
    bilinear_sd:     number[];
    bilinear_sa:     number[];
  };
  mdof_target: {
    D_target_m:        number;
    pushover_step?:    number;
    drift_pct?:        number;
    base_shear_kN?:    number;
    // Pórticos (ASCE 41): presentes cuando el N2 corre sobre un pushover de frame.
    n_hinges_IO?:       number;
    n_hinges_LS?:       number;
    n_hinges_CP?:       number;
    n_hinges_collapse?: number;
    // Muros (Park-Ang): presentes cuando el N2 corre sobre un pushover de muros.
    n_piers_none?:      number;
    n_piers_minor?:     number;
    n_piers_moderate?:  number;
    n_piers_severe?:    number;
    n_piers_collapse?:  number;
  };
  warnings:    string[];
  computed_at: string;
}

// ── NLTHA (análisis cronológico no lineal) ──────────────────────────────────

/**
 * Metadata liviana de un job NLTH histórico. Un proyecto puede tener N
 * análisis cronológicos, cada uno con su carpeta `nlth/<job_id>/` y su
 * propio `meta.json`. Este es el shape que devuelve `/nlth/jobs`.
 */
export interface NLTHJobMeta {
  job_id:         string;
  project_id:     string;
  system:         "frames" | "walls";
  record_x_file:  string;
  record_y_file:  string;
  scale:          number;
  dtrec:          number;
  dt_analysis:    number;
  damping:        number;
  record_units:   string;
  duration:       number | null;
  collapse_mode:  string;
  status:         string;
  max_drift_pct:  number;
  max_roof_m:     number;
  pga_x_g:        number;
  pga_y_g:        number;
  Vb_peak_kN:     number;
  residual_drift_pct: number;
  t_elapsed_s:    number;
  t_target_s:     number;
  wall_time_min:  number;
  aborted:        boolean;
  abort_reason:   string | null;
  computed_at:    string;              // ISO-8601 UTC
  has_history_npz: boolean;
}

export interface NLTHUploadResult {
  ok:           boolean;
  direction:    "X" | "Y";
  path:         string;              // clean_path, lo que va al task
  source_path:  string;
  filename:     string;
  format:       "peer_at2" | "fema_flat" | "csv_time_acc" | "flat_whitespace";
  n_samples:    number;
  dt_detected:  number | null;
  duration_s:   number | null;
  pga:          number;
  units_hint:   "g" | "mps2" | "cm/s2" | null;
  header_lines: string[];
  description:  string;
  preview:      { t: number[]; a: number[]; stride: number };
  /** Si el registro vino de la biblioteca FEMA, trae el id del par y nombre. */
  fema_pair_id?: number;
  fema_gm_name?: string;
}

// ── FEMA P-695 library ──────────────────────────────────────────────────────

export interface FEMAPair {
  pair:        number;             // 1..22
  earthquake:  string;             // "Northridge"
  year:        number;             // 1994
  mw:          number;             // 6.7
  station:     string;             // "Beverly Hills - Mulhol"
  rrup_km:     number;             // 13.3
  files:       [string, string];   // ["GM01", "GM02"]
  dt:          [number, number];   // dt de cada componente (s)
  pga:         (number | null)[];  // PGA máx de cada componente (g)
  duration_s:  (number | null)[];
  n_samples:   (number | null)[];
  spectra: {
    periods:  number[];
    geomean:  number[];
    [gm_key: string]: number[];     // "gm01": [...], "gm02": [...]
  } | null;
}

export interface FEMALibraryCatalog {
  pairs:     FEMAPair[];
  periods:   number[];
  available: boolean;
}

// ── Catálogos locales (campañas colombianas) — shape compatible con FEMAPair ─

export interface LocalPair extends FEMAPair {
  region:        string;             // "CALI" | "MANIZALES" | "PEREIRA" | "SGC"
  soil_class:    string | null;      // "S1".."S5"
  latitude:      number | null;
  longitude:     number | null;
  campaign:      string;
  event_date:    string;
  record_h1_id:  string;
  record_h2_id:  string;
}

export interface LocalCampaign {
  campaign:   string;
  label:      string;
  earthquake: string | null;
  event_date: string | null;
  mw:         number | null;
  n_records:  number;
}

export interface LocalCatalog {
  campaign:  string;
  pairs:     LocalPair[];
  periods:   number[];
  available: boolean;
}

export interface LocalRecordPreview {
  name:        string;
  t:           number[];
  a:           number[];
  dt:          number;
  n_full:      number;
  pga:         number;
  duration_s:  number;
  region:      string | null;
  station:     string | null;
  component:   string | null;
  soil_class:  string | null;
}

export interface FEMARecordPreview {
  gm_name:     string;
  t:           number[];
  a:           number[];
  dt:          number;
  n_full:      number;
  pga:         number;
  duration_s:  number;
}

export interface FEMAScaleResult {
  pair_id:                 number;
  T1_s:                    number;
  xi:                      number;
  sa_target_g:             number;
  sa_h1_unscaled_g:        number;
  sa_h2_unscaled_g:        number;
  sa_geomean_unscaled_g:   number;
  sa_geomean_scaled_g:     number;
  scale:                   number;
}

export interface FEMASelectResult {
  pair: {
    pair_id:    number;
    earthquake: string;
    year:       number;
    mw:         number;
    station:    string;
    rrup_km:    number;
    files:      [string, string];
  };
  scale:       number;
  scale_info:  Record<string, number | string>;
  upload_x:    NLTHUploadResult;
  upload_y:    NLTHUploadResult;
}

export interface NLTHDamageHinges {
  status:       "success" | "no_data";
  scheme:       string;
  thresholds:   { IO: number; LS: number; CP: number; collapse: number };
  counts:       { none: number; io: number; ls: number; cp: number; collapse: number };
  max_theta_p:  number;
  worst_elements: Array<{ element: number; theta_p_max: number; level: string }>;
}

export interface NLTHDamagePiers {
  status:    "success" | "no_data";
  scheme:    string;
  ductility: string;
  drift_cap: number;
  counts:    { none: number; minor: number; moderate: number; severe: number; collapse: number };
  max_di:    number;
  stories:   Array<{ story_idx: number; z_m: number; max_drift_pct: number; DI: number; level: string }>;
}

export interface NLTHResult {
  status:        "success" | "partial";
  system:        "walls" | "frames";
  project_id:    string;
  computed_at:   string;
  record_x_file: string;
  record_y_file: string;
  t_s:           number[];
  techo: {
    x:     number[];
    y:     number[];
    total: number[];
  };
  Vb_history: {
    x_kN: number[];
    y_kN: number[];
  };
  envelope: {
    max_abs_disp_x_m:            number;
    max_abs_disp_y_m:            number;
    max_drift_x_pct:             number;
    max_drift_y_pct:             number;
    max_drift_pct:               number;
    max_drift_by_story_x:        number[];
    max_drift_by_story_y:        number[];
    /** Aceleración ABSOLUTA máx por piso = ü_rel + ü_g. Es la que mide un
     *  acelerómetro en el piso (relevante para daño a contenido, NSR-10 A.9). */
    max_abs_accel_by_story_x_mps2?: number[];
    max_abs_accel_by_story_y_mps2?: number[];
    /** Aceleración relativa al suelo (deformación dinámica del edificio). */
    max_rel_accel_by_story_x_mps2?: number[];
    max_rel_accel_by_story_y_mps2?: number[];
    /** Alias legacy — hoy apunta a la absoluta (que es la métrica correcta). */
    max_accel_by_story_x_mps2:   number[];
    max_accel_by_story_y_mps2:   number[];
    /** PGA del registro ya con factor/escala aplicados. */
    pga_x_mps2?:                 number;
    pga_y_mps2?:                 number;
    pga_x_g?:                    number;
    pga_y_g?:                    number;
    pga_vector_g?:               number;
    /** Factor de amplificación por piso: PFA_i / PGA (adimensional). */
    accel_amplification_by_story_x?: number[];
    accel_amplification_by_story_y?: number[];
    max_accel_amplification?:        number;
    max_Vb_x_kN:                 number;
    max_Vb_y_kN:                 number;
    max_roof_disp_total_m:       number;
    t_elapsed_s:                 number;
    t_target_s:                  number;
  };
  damage: NLTHDamageHinges | NLTHDamagePiers;
  events?: LocalEventsPayload;
  element_lines?: ElementLine[];
  infill_lines?:  InfillLine[];
  infill_damage?: InfillDamageHistory;
  /** Daño por deriva de entrepiso (FEMA 356 / HAZUS). Complementa infill_damage. */
  infill_damage_by_drift?: InfillDamageByDrift;
  /** Clasificación cruzada ASCE 41 × hinges del NLTHA por columna. */
  failure_modes?: FailureModesClassification;
  runtime?: {
    wall_time_s:    number;    // segundos de reloj
    wall_time_min:  number;    // minutos de reloj
    t_simulated_s:  number;    // seg del registro procesados
    speed_ratio:    number;    // seg wall / seg simulado
  };
  meta: {
    dtrec:          number;
    dt_analysis:    number;
    damping:        number;
    scale:          number;
    record_units:   string;
    factor_applied: number;
    duration_s:     number;
    total_height_m: number;
    n_stories:      number;
    eletype:        "wall" | "frame";
    ductility:      string;
  };
  history: {
    path:       string;
    n_steps:    number;
    dt_rec:     number;
    n_elements: number;
  } | null;
  /** Diagnóstico de salud del solver (Ola 2 2026-11-04). Siempre presente;
   *  cuando status=success y no hubo bisecciones, los campos son neutrales. */
  health?: AnalysisHealth;
}

export interface AnalysisHealth {
  status: "success" | "partial" | "stall";
  aborted: boolean;
  abort_reason:
    | "step_fail" | "stall" | "user_cancel" | "vb_near_zero" | "slow_progress"
    | "bulldozer_failed" | null;
  /** Para abort_reason=slow_progress: ratio dt_actual/dt_nominal al cortar. */
  slow_dt_ratio?: number;
  /** Modo bulldozer: solver aceptó error local severo en elementos patológicos
   *  para que el resto del edificio avance por redistribución (Ola 6). */
  bulldozer_activated?:   boolean;
  bulldozer_steps_total?: number;
  bulldozer_t_entered?:   number;
  abort_time_s?:       number | null;
  abort_time_target_s?: number | null;
  /** Para pushover */
  abort_step?:       number | null;
  abort_drift_pct?:  number | null;
  /** Para pushover con colapso (abort_reason=vb_near_zero). Umbral actual:
   *  Vb ≤ 25 % del pico → se considera colapso del edificio (75 % pérdida). */
  vb_peak_kN?:       number;
  vb_at_abort_kN?:   number;
  vb_loss_pct?:      number;
  n_failed_steps:        number;
  n_bisections_total:    number;
  n_fallback_algorithm?: number;
  max_dt_reduction?:     number;
  pathological_element?: PathologicalElement | null;
  pathological_ranking?: PathologicalElement[];
}

export interface PathologicalElement {
  ele_tag:       number;
  fid?:          string;
  kind?:         string;
  story?:        string;
  theta_p_max?:  number;
  strain_axial?: number;
  force_max_kN?: number;
  b_m?:          number;
  h_m?:          number;
}

// ── Ola 7: Diagnóstico post-NLTH del elemento + recomendaciones ──────────────

export type ReinforcementActionId =
  | "fix_hook_90"
  | "fix_splice_in_hinge"
  | "reduce_tie_spacing"
  | "add_tie_legs"
  | "upgrade_tie_diameter"
  | "cfrp_wrap"
  | "upgrade_long_bars"
  | "enlarge_section"
  | "short_beam_coupling_detail";

export interface ReinforcementOption {
  action_id:           ReinforcementActionId | string;
  description:         string;
  cost_tier:           1 | 2 | 3;
  cost_estimate_usd:   number;
  rationale:           string;
  changes:             Record<string, unknown>;
  theta_cap_new:       number;
  theta_u_new:         number;
  Vn_new_kN:           number;
  Vp_over_Vn_new:      number;
  failure_mode_new:    string;
  theta_cap_gain_pct:  number;
  Vn_gain_pct:         number;
  new_theta_dcr:       number;
  new_vd_dcr:          number;
  meets_target:        boolean;
  notes:               string[];
}

export interface ElementDiagnosis {
  fid:              string;
  kind:             string;
  story:            string;
  b_m:              number;
  h_m:              number;
  L_m:              number;
  rho_long:         number;
  rho_sh:           number;
  s_confined_mm:    number;
  n_legs_h:         number;
  tie_bar_label:    string;
  long_bar_label:   string;
  theta_IO:         number;
  theta_LS:         number;
  theta_CP:         number;
  theta_u:          number;
  Vp_kN:            number;
  Vn_kN:            number;
  Vp_over_Vn:       number;
  failure_mode:     string;
  asce_condition:   string;
  flags:            string[];
  theta_demand:     number;
  V_demand_kN:      number | null;
  theta_dcr:        number;
  recommendations:  ReinforcementOption[];
  verdict:          string;
  verdict_class:    "ok" | "info" | "warning" | "danger";
}

export interface ApplyReinforcementFixRequest {
  fid:        string;
  action_id:  string;
  changes:    Record<string, unknown>;
  notes?:     string;
}

export interface ApplyReinforcementFixResponse {
  saved:      boolean;
  fid:        string;
  action_id:  string;
  message:    string;
}

// ── Ola 8: Performance-based design verifier ────────────────────────────────

export type PerformanceLevel = "IO" | "LS" | "CP";

export interface ElementVerification {
  fid:                  string;
  kind:                 string;
  story:                string;
  performance_level:    string;
  theta_target:         number;
  theta_CP_initial:     number;
  theta_CP_final:       number;
  meets_target_initial: boolean;
  meets_target_final:   boolean;
  iterations:           number;
  adjustments:          string[];
  changes:              Record<string, unknown>;
  failure_mode_final:   string;
  Vn_final_kN:          number;
  Vp_over_Vn_final:     number;
  unmet_reason:         string | null;
}

export interface PerformanceVerificationResult {
  performance_level:    string;
  theta_targets:        { column: number; beam: number };
  method:               string;
  n_elements:           number;
  n_initial_pass:       number;
  n_adjusted:           number;
  n_unmet:              number;
  max_iterations:       number;
  elements:             ElementVerification[];
  summary_adjustments:  Record<string, number>;
  warnings:             string[];
  saved_fixes?:         boolean;
  saved_fixes_count?:   number;
}

export interface PerformanceVerifyRequest {
  performance_level:    PerformanceLevel;
  theta_target_column?: number;
  theta_target_beam?:   number;
  method?:              "haselton" | "ec8_3" | "mecanico";
  max_iterations?:      number;
  skip_coupling_beams?: boolean;
  save_fixes?:          boolean;
}

// ── IDA — Incremental Dynamic Analysis ──────────────────────────────────────

export interface IDALaunchRequest {
  pair_ids:      number[];
  sa_min:        number;
  sa_max:        number;
  n_levels:      number;
  T1_s:          number;
  system?:       "frames" | "walls";
  damping?:      number;
  dt_analysis?:  number;
  spacing?:      "linear" | "log";
  collapse_mode?: "ductile" | "brittle";
  catalog_source?: string;   // "fema" | "colombia_2026_08_10" | ...
}

export interface IDALaunchResponse {
  job_id:     string;
  celery_id:  string;
  pair_ids:   number[];
  n_levels:   number;
  n_total:    number;
  status:     string;
  message:    string;
}

/**
 * Daño agregado por piso dentro de un análisis individual.
 * Clave del dict `hinges_by_story` = etiqueta del piso (p. ej. "P03").
 */
export interface IDAHingeStoryCount {
  io:             number;
  ls:             number;
  cp:             number;
  collapse:       number;
  total:          number;
  theta_max_col:  number;
  theta_max_beam: number;
}

export interface IDACurvePoint {
  Sa_g:              number;
  level_index:       number;
  status?:           string;
  max_drift_pct:     number | null;
  max_roof_m?:       number;
  Vb_peak_kN?:       number;
  theta_col_max?:    number;
  theta_beam_max?:   number;
  collapsed:         boolean | null;
  aborted?:          boolean;
  abort_reason?:     string | null;
  worst_fid?:        string;
  n_critical_cols?:  number;
  n_critical_beams?: number;
  // ── Perfiles por piso (Ola A — radiografía post-sismo) ────────────────────
  stories_z?:                      number[];
  max_drift_by_story_x_pct?:       number[];
  max_drift_by_story_y_pct?:       number[];
  max_abs_accel_by_story_x_mps2?:  number[];
  max_abs_accel_by_story_y_mps2?:  number[];
  max_disp_by_story_x_m?:          number[];
  max_disp_by_story_y_m?:          number[];
  accel_amp_by_story_x?:           number[];
  accel_amp_by_story_y?:           number[];
  pga_x_g?:                        number;
  pga_y_g?:                        number;
  pga_vector_g?:                   number;
  residual_drift_pct?:             number;
  residual_drift_x_pct?:           number;
  residual_drift_y_pct?:           number;
  residual_drift_by_story_x_pct?:  number[];
  residual_drift_by_story_y_pct?:  number[];
  critical_story_idx?:             number;
  critical_story_drift_pct?:       number;
  hinges_by_story?:                Record<string, IDAHingeStoryCount>;
}

/**
 * Percentiles entre pares para un perfil por piso (Ola A).
 * Cada array tiene longitud = n_stories; indexado del piso 1 (más bajo) hacia arriba.
 */
export interface IDAProfilePercentiles {
  p16: number[];
  p50: number[];
  p84: number[];
}

export interface IDAStatsPerLevel {
  Sa_g:              number;
  level_index:       number;
  drift_p16:         number;
  drift_p50:         number;
  drift_p84:         number;
  theta_col_p50:     number;
  theta_col_p84:     number;
  residual_p50?:     number;
  residual_p84?:     number;
  pga_p50_g?:        number;
  n_collapsed:       number;
  n_total:           number;
  collapse_frac:     number;
  // ── Perfiles por piso (envolvente X,Y) — percentiles entre pares ──────────
  drift_profile?:    IDAProfilePercentiles;
  accel_profile?:    IDAProfilePercentiles;
  disp_profile?:     IDAProfilePercentiles;
  accel_amp_profile?: IDAProfilePercentiles;
}

export interface IDAResult {
  meta: {
    ida_job_id:   string;
    pair_ids:     number[];
    sa_levels:    number[];
    sa_min:       number;
    sa_max:       number;
    n_levels:     number;
    T1_s:         number;
    system:       string;
    damping:      number;
    spacing:      string;
    launched_at:  string;
    total_runs:   number;
  };
  curves:               Record<string, IDACurvePoint[]>;   // key = pair_id string
  stats_per_level:      IDAStatsPerLevel[];
  sa_median_collapse_g: number | null;
  // Ola A — información global de la "radiografía post-sismo"
  stories_z?:              number[];
  n_stories?:              number;
  most_critical_story_idx?: number | null;
  n_pairs:              number;
  n_levels:             number;
  computed_at:          string;
  job_id?:              string;
}

export interface IDAProgress {
  job_id:   string;
  status:   string;
  n_done:   number;
  n_total:  number;
  pct:      number;
  progress: Record<string, unknown> | null;
  meta:     IDAResult["meta"] | null;
}

export interface IDAJobSummary {
  job_id:         string;
  status:         string;
  created_at:     string | null;
  finished_at:    string | null;
  params:         IDALaunchRequest | null;
  result_summary: {
    n_pairs:              number;
    n_levels:             number;
    n_total:              number;
    n_ok:                 number;
    n_collapsed:          number;
    sa_median_collapse_g: number | null;
  } | null;
}

// ── NLRHA — Verificación NSR-10 / ASCE 7-22 Cap 16 ──────────────────────────

export interface NLRHALaunchRequest {
  pair_ids:        number[];
  Aa:              number;             // NSR-10 A.2.3
  Av:              number;
  soil_type:       "A" | "B" | "C" | "D" | "E";
  use_group:       "I" | "II" | "III" | "IV";
  T1_s:            number;
  mce_multiplier?: number;             // 1.0 (SDE) · 1.5 (MCE_R)
  system?:         "frames" | "walls";
  damping?:        number;
  dt_analysis?:    number;
  catalog_source?: string;             // "fema" | "colombia_2026_08_10" | ...
}

export interface NLRHASpectralParams {
  SDs: number; SD1: number;
  T0:  number; Ts:  number; TL: number;
  Fa:  number; Fv:  number;
}

export interface NLRHALaunchResponse {
  job_id:          string;
  celery_id:       string;
  pair_ids:        number[];
  sa_nsr10_T1_g:   number;
  I_factor:        number;
  mce_multiplier:  number;
  sa_target_g:     number;
  spectral_params: NLRHASpectralParams;
  status:          string;
  message:         string;
}

/** Verificación piso-por-piso vs límite NSR-10 A.6.4.2 (1 % deriva). */
export interface NLRHAStoryVerification {
  story:           number;
  drift_p50_pct:   number;
  drift_p84_pct:   number;
  ratio_vs_limit:  number;
  ok:              boolean;
}

export interface NLRHAVerification {
  overall:         "pass" | "fail" | "no_data";
  limit_mean_pct:  number;
  limit_max_pct:   number;
  stories:         NLRHAStoryVerification[];
  n_pairs:         number | null;
  n_collapsed:     number | null;
}

/**
 * NLRHAResult = IDAResult de 1 solo nivel + metadatos NSR-10 + verificación.
 * Comparte el mismo esquema para reusar el task de IDA y todo el pipeline
 * post-proceso (perfiles, hinges por piso, residual).
 */
export interface NLRHAResult extends IDAResult {
  nlrha_meta?: {
    mode?:              string;              // "nlrha"
    nsr10_Aa?:          number;
    nsr10_Av?:          number;
    soil_type?:         string;
    use_group?:         string;
    importance_factor?: number;
    mce_multiplier?:    number;
    sa_nsr10_T1_g?:     number;
    sa_target_g?:       number;
    spectral_params?:   NLRHASpectralParams;
  };
  nsr10_verification: NLRHAVerification;
}

// ── Variantes de diseño (Fase 6) ─────────────────────────────────────────────

export interface DesignVariantOverride {
  be_n_bars?:  number;
  be_db_mm?:   number;
  rho_v_pct?:  number;
  rho_h_pct?:  number;
  fc_mpa?:     number;
  fy_mpa?:     number;
  notes?:      string;
}

export type VariantStatus = "draft" | "analyzing" | "analyzed" | "failed";

export interface DesignVariant {
  variant_id:            string;
  created_at:            string;
  updated_at:            string;
  name:                  string;
  description:           string;
  based_on:              string;
  overrides:             Record<string, DesignVariantOverride>;  // key = "pier|story"
  status:                VariantStatus;
  analysis_job_id:       string | null;
  analysis_result_path:  string | null;
  analyzed_at?:          string | null;
  error_message?:        string | null;
}

export interface NLPushoverVariantResult extends NLPushoverResult {
  variant_id:    string;
  variant_name?: string;
  n_overrides:   number;
}

export interface DesignVariantsResponse {
  variants: DesignVariant[];
}

export interface PierResponseData {
  pier:            string;
  story:           string;
  direction:       string;
  lw_m:            number;
  hw_m:            number;
  lp_m:            number;
  M_phi:           MPhiPoint[];
  V_delta:         VDeltaPoint[];
  yield_M_phi?:    (MPhiPoint & { note: string }) | null;
  yield_V_delta?:  (VDeltaPoint & { note: string }) | null;
  damage?: {
    di:        number;
    di_base:   number;
    level:     DamageLevel;
    drift_pct: number;
  } | null;
}
