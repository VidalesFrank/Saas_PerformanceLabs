// Tipos TypeScript para el módulo Ground Motion Analysis

// ── Detección de estructura del archivo ────────────────────────────────────

export interface ColumnInfo {
  index: number
  header: string
  n_valid: number
  n_nan: number
  min_val: number
  max_val: number
  mean_val: number
  is_monotonic_increasing: boolean
  is_oscillatory: boolean
  delta_stats: {
    mean: number; min: number; max: number; std: number; cv: number; regular: boolean
  } | null
  preview: number[]
  suggested_role: 'likely_time' | 'possible_time' | 'possible_signal' | 'unknown'
  confidence: number
}

export interface DetectedStructure {
  filename: string
  file_format: string
  n_rows: number
  n_cols: number
  has_header: boolean
  delimiter: string
  header_metadata: Record<string, number | string>
  n_skipped_rows: number
  warnings: string[]
  preview_rows: (number | null)[][]
  columns: ColumnInfo[]
}

// ── Mapeo de columnas (wizard step 2) ─────────────────────────────────────

export type ColumnQuantity = 'acceleration' | 'time' | 'velocity' | 'displacement' | 'ignore'
export type AccUnit = 'g' | 'm/s²' | 'cm/s²' | 'Gal' | 'mm/s²'
export type TimeUnit = 's' | 'ms'

export interface ColumnMappingIn {
  col_index: number
  quantity: ColumnQuantity
  unit: string
  component: string
  name: string
}

// ── Registro de movimiento del suelo ──────────────────────────────────────

export interface GMRecord {
  id: string
  name: string
  source_file: string | null
  dt: number | null
  n_samples: number | null
  duration: number | null
  acc_unit_original: string | null
  metadata_json: Record<string, string | number>
  created_at: string
  updated_at?: string
  jobs?: GMJob[]
}

// ── Job de análisis ────────────────────────────────────────────────────────

export type GMJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

export interface GMJob {
  id: string
  job_type: string
  status: GMJobStatus
  result_summary: Record<string, unknown> | null
  error_message: string | null
  created_at: string
  finished_at: string | null
}

// ── Historia de tiempo ─────────────────────────────────────────────────────

export interface TimeseriesData {
  t: number[]
  a_ms2: number[]
  a_raw: number[]
  a_unit_original: string
  component: string
  dt: number
  n_samples: number
  duration: number
  fs: number
  nyquist: number
  pga_ms2: number
  pga_pos_ms2: number
  pga_neg_ms2: number
  t_pga: number
  v_ms: number[]
  d_m: number[]
  pgv_ms: number
  pgd_m: number
}

// ── Parámetros de intensidad ────────────────────────────────────────────────

export interface IntensityMeasures {
  pga_ms2: number
  pga_g: number
  pga_pos_ms2: number
  pga_neg_ms2: number
  t_pga: number
  pgv_ms: number
  pgv_cms: number
  pgd_m: number
  pgd_cm: number
  t_pgv: number
  t_pgd: number
  pgv_pga_ratio: number
  arias_intensity_ms: number
  arias_intensity_cms: number
  D5_95: number
  D5_95_t_start: number
  D5_95_t_end: number
  D5_75: number
  D5_75_t_start: number
  D5_75_t_end: number
  cav_ms: number
  rms_acc_ms2: number
  rms_vel_ms: number
  rms_disp_m: number
  rms_acc_g: number
  duration_record: number
  dt: number
  fs: number
  nyquist: number
  ia_cumulative: number[]
  ia_cumulative_normalized: number[]
  t: number[]
  D5_95_details: Record<string, number>
  D5_75_details: Record<string, number>
}

// ── FFT ────────────────────────────────────────────────────────────────────

export interface FFTResult {
  fft: {
    freq: number[]
    period: number[]
    amplitude: number[]
    phase: number[]
    nyquist_hz: number
    dominant_freq_hz: number
    dominant_period_s: number
    n: number
    fs: number
  }
  psd: {
    freq: number[]
    psd: number[]
    nyquist_hz: number
    dominant_freq_hz: number
    dominant_period_s: number
  }
  dt: number
  fs: number
  nyquist: number
  n_samples: number
}

// ── Espectro de respuesta ──────────────────────────────────────────────────

export interface SpectrumResult {
  T: number[]
  Sd: number[]
  Sv: number[]
  Sa: number[]
  PSV: number[]
  PSA: number[]
  xi: number
  component: string
  record_name: string
}

export interface SpectrumMultiXiResult {
  T: number[]
  spectra: Record<string, { Sd: number[]; Sv: number[]; Sa: number[]; PSV: number[]; PSA: number[] }>
  xi_list: number[]
  component: string
  record_name: string
}

export interface SpectrumAtPeriodResult {
  T: number
  xi: number
  Sd: number
  Sv: number
  Sa: number
  PSV: number
  PSA: number
  u_history: number[]
  v_history: number[]
  a_abs_history: number[]
}

// ── Procesamiento ──────────────────────────────────────────────────────────

export interface ProcessResult {
  operation: string
  report: Record<string, number | string>
  t: number[]
  a_ms2: number[]
  a_original_ms2: number[]
  v_ms: number[]
  d_m: number[]
}

// ── Wizard state ───────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4

export interface WizardState {
  step: WizardStep
  file: File | null
  detected: DetectedStructure | null
  columnMappings: ColumnMappingIn[]
  dt: string
  dtUnit: TimeUnit
  recordName: string
  metadata: Record<string, string>
  error: string | null
  isLoading: boolean
}

// ── Import request ─────────────────────────────────────────────────────────

export interface CreateRecordRequest {
  name: string
  column_mappings: ColumnMappingIn[]
  dt: number | null
  metadata: Record<string, string>
}
