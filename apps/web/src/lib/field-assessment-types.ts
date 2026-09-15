// ── Fase 0 — Tipos compartidos frontend/backend ─────────────────────────────

export type Placard = "green" | "yellow" | "red";
export type AssessmentStage = "draft" | "safety_done" | "triage_done" | "archived";
export type SyncStatus = "local_only" | "pending_sync" | "synced";

export type DamageLevel = "D0" | "D1" | "D2" | "D3" | "D4" | "D5";
export type HazardResponse = "yes" | "no" | "na";
export type HazardSeverity = "light" | "moderate" | "severe";
export type Access = "ok" | "obstructed" | "damaged" | "collapsed";
export type Direction = "X" | "Y";

export type StructuralSystem =
  | "rc_frame"
  | "rc_wall"
  | "rc_dual"
  | "rc_infill"
  | "masonry_confined"
  | "urm"
  | "steel"
  | "wood"
  | "tilt_up"
  | "lift_slab"
  | "other";

export type TriageDecision =
  | "low_risk"
  | "asce41_candidate"
  | "high_risk"
  | "not_applicable";

// ── Sub-flujo A ──────────────────────────────────────────────────────────────

export interface HazardCheck {
  code: string;
  response: HazardResponse;
  severity?: HazardSeverity;
  note?: string;
}

export interface ComponentDamageItem {
  component: string;
  level: DamageLevel;
  pct_affected?: number;
}

export interface AccessCondition {
  main_door: Access;
  emergency_exits: Access;
  stairs: Access;
  elevator_out_of_service: boolean;
}

// ── Sub-flujo B ──────────────────────────────────────────────────────────────

export interface ComponentInput {
  tag: string;
  kind: "column" | "wall";
  delta_D: number;
  delta_C_base: number;
  damage: DamageLevel;
}

export interface StoryInputPayload {
  index: number;
  height_m: number;
  direction: Direction;
  components: ComponentInput[];
}

export interface ExceptionalFlagsInput {
  no_asbuilt_docs?: boolean;
  incomplete_load_path?: boolean;
  discontinuous_walls?: boolean;
  exceptionally_weak?: boolean;
  extreme_torsion?: boolean;
  separation_mm?: number | null;
  shorter_building_height_m?: number | null;
  geotech_hazard?: boolean;
  notes?: Record<string, string>;
}

export interface ShortcutInputPayload {
  area_walls_x_m2?: number | null;
  area_walls_y_m2?: number | null;
  seismic_weight_kN?: number | null;
  wsi_threshold?: number;
  global_ratio_D_over_C?: number | null;
  elastic_threshold?: number;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export interface BuildingSnapshotDTO {
  address_line?: string | null;
  city?: string | null;
  municipio_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  year_built?: number | null;
  n_stories_above?: number | null;
  n_stories_below?: number | null;
  total_height_m?: number | null;
  plan_area_m2?: number | null;
  structural_system?: StructuralSystem | null;
  floor_system?: string | null;
  occupancy_use_nsr10?: string | null;
  has_asbuilt_docs: boolean;
  has_geotech_hazard: boolean;
}

// ── Respuestas del servidor ──────────────────────────────────────────────────

export interface SafetyEvaluationDTO {
  inspector_name?: string | null;
  inspector_id?: string | null;
  inspector_org?: string | null;
  inspected_at?: string | null;
  hazards?: { checks: HazardCheck[] } | null;
  component_damage?: { items: ComponentDamageItem[] } | null;
  access_condition?: AccessCondition | null;
  residual_drift_pct?: number | null;
  placard?: Placard | null;
  placard_reasons?: string[] | null;
  restrictions?: string[] | null;
  manual_override?: Placard | null;
  manual_override_reason?: string | null;
}

export interface ComponentRating {
  tag: string;
  kind: string;
  delta_D: number;
  delta_C_base: number;
  damage: string;
  lambda_damage: number;
  delta_C_adj: number;
  ratio: number;
  rating: number;
}

export interface StoryRating {
  index: number;
  direction: string;
  Nc: number;
  Nw: number;
  components: ComponentRating[];
  CR: number;
  WR: number;
  SR: number;
}

export interface TriageResultDTO {
  applicability_ok: boolean;
  exceptional_flags?: ExceptionalFlagsInput | null;
  shortcut_applied?: string | null;
  stories?: StoryInputPayload[] | null;
  story_ratings?: StoryRating[] | null;
  building_rating?: number | null;
  decision?: TriageDecision | null;
  decision_reason?: string | null;
  table_6_6_config_id?: string | null;
}

export interface FieldPhotoDTO {
  id: string;
  file_path: string;
  latitude?: number | null;
  longitude?: number | null;
  taken_at?: string | null;
  component_tag?: string | null;
  caption?: string | null;
}

export interface FieldAssessmentDTO {
  id: string;
  client_uuid: string;
  title: string;
  stage: AssessmentStage;
  sync_status: SyncStatus;
  linked_building_project_id?: string | null;
  client_created_at?: string | null;
  created_at: string;
  updated_at: string;
  snapshot?: BuildingSnapshotDTO | null;
  safety_evaluation?: SafetyEvaluationDTO | null;
  triage_result?: TriageResultDTO | null;
  photos: FieldPhotoDTO[];
}
