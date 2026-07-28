// ── Tipos para el Módulo 3 — Análisis No Lineal 3D de Edificios ──────────────

export type AnalysisType = "archetype" | "modal" | "pushover" | "dynamic";
export type JobStatus    = "pending" | "running" | "success" | "failed" | "cancelled";

export interface BuildingProject {
  id: string;
  name: string;
  description: string | null;
  parameters_json: BuildingParameters | null;
  input_file_path: string | null;
  e2k_file_path:   string | null;
  rebar_file_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildingParameters {
  proyect_name:       string;
  city:               string;
  soil_type:          string;          // A / B / C / D / E
  edification_use:    string;          // I / II / III / IV
  construction_year:  number;
  code:               string;          // NSR-10
  structure_system:   string;          // RCMRF / WRCF / DUAL
  confined_elements:  string;
  energy_dissipation: string;
  integration_points: number;
  load_case:          string;
  cm_load:            string;
  cv_load:            string;
  shell_craking:      number;
  rebar_type:         string;
}

export interface BuildingJob {
  id: string;
  celery_task_id: string | null;
  analysis_type: AnalysisType;
  status: JobStatus;
  result_path:    string | null;
  result_summary: Record<string, unknown> | null;
  error_message:  string | null;
  project_id: string;
  created_at: string;
  finished_at: string | null;
}

// ── Resultados del análisis modal ─────────────────────────────────────────────

export interface ModeRow {
  mode:   number;
  T:      number;
  Ux_pct: number;
  Uy_pct: number;
  Rz_pct: number;
  Ux_cum: number;
  Uy_cum: number;
  Rz_cum: number;
}

export interface ModalViewer {
  nodes:       Record<string, [number, number, number]>;
  mode_shapes: Record<string, Record<string, [number, number, number]>>;
  elements:    [number, number][];
}

export interface ModalResult {
  num_modes:   number;
  num_floors:  number;
  modes_table: ModeRow[];
  viewer:      ModalViewer;
}

// ── Resultados del análisis pushover ─────────────────────────────────────────

export interface PushoverDirSummary {
  vmax_kN:         number;
  vmax_norm:       number;
  drift_techo_max: number;
  n_steps:         number;
  elapsed_s:       number;
  status:          "success" | "partial";
}

export interface PushoverDirData {
  dtecho:      number[];
  vbasal:      number[];
  vbasal_norm: number[];
  summary:     PushoverDirSummary;
  [key: string]: unknown;
}

export interface PushoverResult {
  story_heights: number[];
  elapsed_s:     number;
  X?: PushoverDirData;
  Y?: PushoverDirData;
}

// ── Resultados del análisis dinámico ─────────────────────────────────────────

export interface EnvelopeCurve {
  p16:  number[];
  mean: number[];
  p84:  number[];
}

export interface DynamicEnvelope {
  drift_x: EnvelopeCurve;
  drift_y: EnvelopeCurve;
}

export interface IdaPoint {
  scale:       number;
  drift_p16:   number;
  drift_mean:  number;
  drift_p84:   number;
  sa_p16:      number;
  sa_mean:     number;
  sa_p84:      number;
}

export interface PairResult {
  pair_id:        number;
  scale:          number;
  record_names:   string[];
  max_drift_x:    number[];
  max_drift_y:    number[];
  max_roof_x_pct: number;
  max_roof_y_pct: number;
  sa_geomean_g:   number | null;
  status:         "success" | "failed";
}

export interface DynamicResult {
  n_pairs_run:   number;
  n_success:     number;
  scale_factors: number[];
  elapsed_s:     number;
  envelope:      DynamicEnvelope;
  ida_curve:     IdaPoint[];
  pairs:         PairResult[];
}

// ── Parámetros de análisis desde UI ──────────────────────────────────────────

export interface PushoverParams {
  pattern_type: "uniforme" | "triangular" | "modal";
  Dmax:         number;   // deriva máxima control (fracción, ej. 0.10 = 10%)
  DInc:         number;   // incremento de desplazamiento
  tag_pattern:  number;
  odb_tag:      number;
  push_error:   number;
  maxNumIter:   number;
}

export interface DynamicParams {
  damping:        number;
  scale_factors:  number[];
  n_pairs:        number;
  dt_analysis:    number;
  parallel_pairs: number;
}
