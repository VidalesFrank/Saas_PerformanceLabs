// ── Tipos para el Módulo 1 — Constructor de Modelos Estructurales ─────────────

export type StructuralAnalysisType = "import_validate" | "modal" | "spectral";
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

export interface ModelGeometry {
  joints: Record<string, JointGeometry>;
  frames: Record<string, FrameGeometry>;
  stories: Record<string, StoryInfo>;
  load_patterns: string[];
  n_joints: number;
  n_frames: number;
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
