// ── Fase 0 — Cliente API ────────────────────────────────────────────────────

import { api } from "./api";
import type {
  BuildingSnapshotDTO,
  ExceptionalFlagsInput,
  FieldAssessmentDTO,
  FieldPhotoDTO,
  ShortcutInputPayload,
  StoryInputPayload,
} from "./field-assessment-types";

const BASE = "/api/v1/field-assessments";

export interface SafetyPayload {
  inspector_name?: string | null;
  inspector_id?: string | null;
  inspector_org?: string | null;
  inspected_at?: string | null;
  hazards?: { checks: unknown[] } | null;
  component_damage?: { items: unknown[] } | null;
  access_condition?: unknown | null;
  residual_drift_pct?: number | null;
  manual_override?: string | null;
  manual_override_reason?: string | null;
}

export interface TriagePayload {
  exceptional_flags?: ExceptionalFlagsInput | null;
  stories?: StoryInputPayload[];
  shortcut?: ShortcutInputPayload | null;
  table_6_6_bands?: Array<{ ratio_low: number; ratio_high: number; rating: number }> | null;
}

export const fieldAssessmentApi = {
  list: () => api.get<FieldAssessmentDTO[]>(BASE),
  create: (title: string, linkedBuildingProjectId?: string) =>
    api.post<FieldAssessmentDTO>(BASE, {
      title,
      client_uuid: (globalThis.crypto?.randomUUID?.() ?? undefined),
      client_created_at: new Date().toISOString(),
      linked_building_project_id: linkedBuildingProjectId ?? null,
    }),
  get: (id: string) => api.get<FieldAssessmentDTO>(`${BASE}/${id}`),
  update: (id: string, patch: { title?: string; stage?: string; linked_building_project_id?: string | null }) =>
    api.patch<FieldAssessmentDTO>(`${BASE}/${id}`, patch),
  remove: (id: string) => api.del<void>(`${BASE}/${id}`),

  saveSnapshot: (id: string, snap: BuildingSnapshotDTO) =>
    api.put<FieldAssessmentDTO>(`${BASE}/${id}/snapshot`, snap),

  saveSafety: (id: string, payload: SafetyPayload) =>
    api.put<FieldAssessmentDTO>(`${BASE}/${id}/safety`, payload),

  uploadPhoto: (id: string, file: File, meta: { latitude?: number; longitude?: number; taken_at?: string; component_tag?: string; caption?: string }) => {
    const form = new FormData();
    form.append("photo", file);
    if (meta.latitude !== undefined)  form.append("latitude", String(meta.latitude));
    if (meta.longitude !== undefined) form.append("longitude", String(meta.longitude));
    if (meta.taken_at)                 form.append("taken_at", meta.taken_at);
    if (meta.component_tag)            form.append("component_tag", meta.component_tag);
    if (meta.caption)                  form.append("caption", meta.caption);
    return api.postForm<FieldPhotoDTO>(`${BASE}/${id}/photos`, form);
  },

  deletePhoto: (assessmentId: string, photoId: string) =>
    api.del<void>(`${BASE}/${assessmentId}/photos/${photoId}`),

  runTriage: (id: string, payload: TriagePayload) =>
    api.post<FieldAssessmentDTO>(`${BASE}/${id}/triage`, payload),

  deleteTriage: (id: string) => api.del<void>(`${BASE}/${id}/triage`),
};
