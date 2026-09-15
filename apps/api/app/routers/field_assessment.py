"""Router — Fase 0: inspección de campo y triaje sísmico post-sismo.

Prefix: /api/v1/field-assessments
Auth:   JWT requerido en todos los endpoints.

Cada usuario gestiona sus propias inspecciones. Los archivos (fotos) se
guardan en: UPLOAD_DIR/field-assessments/{assessment_id}/photos/.
"""
from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.field_assessment_adapter import (
    build_atc20_placard,
    build_fema_triage,
    serialize_triage_stories,
)
from app.models import (
    AssessmentStage,
    BuildingSnapshot,
    FieldAssessment,
    FieldPhoto,
    Placard as PlacardModel,
    SafetyEvaluation,
    SyncStatus,
    TriageDecision as TriageDecisionModel,
    TriageResult,
    User,
)

router = APIRouter(prefix="/api/v1/field-assessments", tags=["field-assessments"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────


class AssessmentCreate(BaseModel):
    title: str
    client_uuid: str | None = None
    client_created_at: datetime | None = None
    linked_building_project_id: str | None = None


class AssessmentUpdate(BaseModel):
    title: str | None = None
    stage: str | None = None
    linked_building_project_id: str | None = None


class SnapshotIn(BaseModel):
    address_line: str | None = None
    city: str | None = None
    municipio_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    year_built: int | None = None
    n_stories_above: int | None = None
    n_stories_below: int | None = None
    total_height_m: float | None = None
    plan_area_m2: float | None = None
    structural_system: str | None = None
    floor_system: str | None = None
    occupancy_use_nsr10: str | None = None
    has_asbuilt_docs: bool = False
    has_geotech_hazard: bool = False


class SafetyIn(BaseModel):
    inspector_name: str | None = None
    inspector_id: str | None = None
    inspector_org: str | None = None
    inspected_at: datetime | None = None
    hazards: dict | None = None                    # { "checks": [...] }
    component_damage: dict | None = None           # { "items": [...] }
    access_condition: dict | None = None
    residual_drift_pct: float | None = None
    manual_override: str | None = None             # "yellow" | "red" | None
    manual_override_reason: str | None = None


class TriageIn(BaseModel):
    exceptional_flags: dict | None = None
    stories: list[dict] = Field(default_factory=list)
    shortcut: dict | None = None
    table_6_6_bands: list[dict] | None = None       # override bandas (opcional)


class PhotoOut(BaseModel):
    id: str
    file_path: str
    latitude: float | None
    longitude: float | None
    taken_at: str | None
    component_tag: str | None
    caption: str | None


class SafetyOut(BaseModel):
    inspector_name: str | None
    inspector_id: str | None
    inspector_org: str | None
    inspected_at: str | None
    hazards: dict | None
    component_damage: dict | None
    access_condition: dict | None
    residual_drift_pct: float | None
    placard: str | None
    placard_reasons: list | None
    restrictions: list | None
    manual_override: str | None
    manual_override_reason: str | None


class TriageOut(BaseModel):
    applicability_ok: bool
    exceptional_flags: dict | None
    shortcut_applied: str | None
    stories: list | None
    story_ratings: list | None
    building_rating: float | None
    decision: str | None
    decision_reason: str | None
    table_6_6_config_id: str | None


class AssessmentOut(BaseModel):
    id: str
    client_uuid: str
    title: str
    stage: str
    sync_status: str
    linked_building_project_id: str | None
    client_created_at: str | None
    created_at: str
    updated_at: str
    snapshot: SnapshotIn | None = None
    safety_evaluation: SafetyOut | None = None
    triage_result: TriageOut | None = None
    photos: list[PhotoOut] = Field(default_factory=list)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _serialize_photo(p: FieldPhoto) -> PhotoOut:
    return PhotoOut(
        id=p.id, file_path=p.file_path,
        latitude=p.latitude, longitude=p.longitude,
        taken_at=p.taken_at.isoformat() if p.taken_at else None,
        component_tag=p.component_tag, caption=p.caption,
    )


def _serialize_safety(s: SafetyEvaluation | None) -> SafetyOut | None:
    if not s:
        return None
    return SafetyOut(
        inspector_name=s.inspector_name, inspector_id=s.inspector_id,
        inspector_org=s.inspector_org,
        inspected_at=s.inspected_at.isoformat() if s.inspected_at else None,
        hazards=s.hazards_json,
        component_damage=s.component_damage_json,
        access_condition=s.access_condition_json,
        residual_drift_pct=s.residual_drift_pct,
        placard=s.placard.value if s.placard else None,
        placard_reasons=s.placard_reasons,
        restrictions=s.restrictions,
        manual_override=s.manual_override.value if s.manual_override else None,
        manual_override_reason=s.manual_override_reason,
    )


def _serialize_triage(t: TriageResult | None) -> TriageOut | None:
    if not t:
        return None
    return TriageOut(
        applicability_ok=t.applicability_ok,
        exceptional_flags=t.exceptional_flags_json,
        shortcut_applied=t.shortcut_applied,
        stories=t.stories_json,
        story_ratings=t.story_ratings_json,
        building_rating=t.building_rating,
        decision=t.decision.value if t.decision else None,
        decision_reason=t.decision_reason,
        table_6_6_config_id=t.table_6_6_config_id,
    )


def _serialize_snapshot(s: BuildingSnapshot | None) -> SnapshotIn | None:
    if not s:
        return None
    return SnapshotIn(
        address_line=s.address_line, city=s.city, municipio_code=s.municipio_code,
        latitude=s.latitude, longitude=s.longitude,
        year_built=s.year_built,
        n_stories_above=s.n_stories_above, n_stories_below=s.n_stories_below,
        total_height_m=s.total_height_m, plan_area_m2=s.plan_area_m2,
        structural_system=s.structural_system, floor_system=s.floor_system,
        occupancy_use_nsr10=s.occupancy_use_nsr10,
        has_asbuilt_docs=s.has_asbuilt_docs,
        has_geotech_hazard=s.has_geotech_hazard,
    )


def _serialize_assessment(a: FieldAssessment) -> AssessmentOut:
    return AssessmentOut(
        id=a.id, client_uuid=a.client_uuid, title=a.title,
        stage=a.stage.value, sync_status=a.sync_status.value,
        linked_building_project_id=a.linked_building_project_id,
        client_created_at=a.client_created_at.isoformat() if a.client_created_at else None,
        created_at=a.created_at.isoformat(),
        updated_at=a.updated_at.isoformat(),
        snapshot=_serialize_snapshot(a.snapshot),
        safety_evaluation=_serialize_safety(a.safety_evaluation),
        triage_result=_serialize_triage(a.triage_result),
        photos=[_serialize_photo(p) for p in a.photos],
    )


def _get_or_404(db: Session, assessment_id: str, user: User) -> FieldAssessment:
    a = db.get(FieldAssessment, assessment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Inspección no encontrada")
    if a.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a esta inspección")
    return a


# ── CRUD del FieldAssessment ──────────────────────────────────────────────────


@router.get("", response_model=list[AssessmentOut])
def list_assessments(user: CurrentUser, db: DB):
    rows = (
        db.query(FieldAssessment)
        .filter(FieldAssessment.owner_id == user.id)
        .order_by(FieldAssessment.created_at.desc())
        .all()
    )
    return [_serialize_assessment(a) for a in rows]


@router.post("", response_model=AssessmentOut, status_code=201)
def create_assessment(payload: AssessmentCreate, user: CurrentUser, db: DB):
    a = FieldAssessment(
        owner_id=user.id,
        title=payload.title,
        client_uuid=payload.client_uuid or str(uuid.uuid4()),
        client_created_at=payload.client_created_at,
        linked_building_project_id=payload.linked_building_project_id,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _serialize_assessment(a)


@router.get("/{assessment_id}", response_model=AssessmentOut)
def get_assessment(assessment_id: str, user: CurrentUser, db: DB):
    return _serialize_assessment(_get_or_404(db, assessment_id, user))


@router.patch("/{assessment_id}", response_model=AssessmentOut)
def update_assessment(assessment_id: str, payload: AssessmentUpdate, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)
    if payload.title is not None:
        a.title = payload.title
    if payload.stage is not None:
        a.stage = AssessmentStage(payload.stage)
    if payload.linked_building_project_id is not None:
        a.linked_building_project_id = payload.linked_building_project_id
    db.commit()
    db.refresh(a)
    return _serialize_assessment(a)


@router.delete("/{assessment_id}", status_code=204)
def delete_assessment(assessment_id: str, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)
    db.delete(a)
    db.commit()


# ── Building snapshot (as-built) ──────────────────────────────────────────────


@router.put("/{assessment_id}/snapshot", response_model=AssessmentOut)
def upsert_snapshot(assessment_id: str, payload: SnapshotIn, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)
    s = a.snapshot
    if s is None:
        s = BuildingSnapshot(assessment_id=a.id)
        db.add(s)
    for key, val in payload.model_dump().items():
        setattr(s, key, val)
    db.commit()
    db.refresh(a)
    return _serialize_assessment(a)


# ── Sub-flujo A: safety evaluation + cálculo del placard ─────────────────────


@router.put("/{assessment_id}/safety", response_model=AssessmentOut)
def upsert_safety(assessment_id: str, payload: SafetyIn, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)

    # Calcular placard usando el engine (siempre — es idempotente).
    placard_value, reasons, restrictions = build_atc20_placard(
        hazards_json=payload.hazards,
        component_damage_json=payload.component_damage,
        access_condition_json=payload.access_condition,
        residual_drift_pct=payload.residual_drift_pct,
        manual_override=payload.manual_override,
        manual_override_reason=payload.manual_override_reason or "",
    )

    s = a.safety_evaluation
    if s is None:
        s = SafetyEvaluation(assessment_id=a.id)
        db.add(s)

    s.inspector_name = payload.inspector_name
    s.inspector_id = payload.inspector_id
    s.inspector_org = payload.inspector_org
    s.inspected_at = payload.inspected_at
    s.hazards_json = payload.hazards
    s.component_damage_json = payload.component_damage
    s.access_condition_json = payload.access_condition
    s.residual_drift_pct = payload.residual_drift_pct
    s.placard = PlacardModel(placard_value.value)
    s.placard_reasons = reasons
    s.restrictions = restrictions
    s.manual_override = PlacardModel(payload.manual_override) if payload.manual_override else None
    s.manual_override_reason = payload.manual_override_reason

    # Avanzar el stage si estaba en draft.
    if a.stage == AssessmentStage.draft:
        a.stage = AssessmentStage.safety_done

    db.commit()
    db.refresh(a)
    return _serialize_assessment(a)


# ── Fotos ─────────────────────────────────────────────────────────────────────


@router.post("/{assessment_id}/photos", response_model=PhotoOut, status_code=201)
async def upload_photo(
    assessment_id: str,
    user: CurrentUser,
    db: DB,
    photo: UploadFile = File(..., description="Imagen JPG/PNG/HEIC"),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    taken_at: datetime | None = Form(None),
    component_tag: str | None = Form(None),
    caption: str | None = Form(None),
):
    a = _get_or_404(db, assessment_id, user)

    dest_dir = os.path.join(settings.upload_dir, "field-assessments", a.id, "photos")
    os.makedirs(dest_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex}_{photo.filename}"
    dest_path = os.path.join(dest_dir, filename)
    with open(dest_path, "wb") as f:
        shutil.copyfileobj(photo.file, f)

    p = FieldPhoto(
        assessment_id=a.id, file_path=dest_path,
        latitude=latitude, longitude=longitude,
        taken_at=taken_at, component_tag=component_tag, caption=caption,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _serialize_photo(p)


@router.delete("/{assessment_id}/photos/{photo_id}", status_code=204)
def delete_photo(assessment_id: str, photo_id: str, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)
    p = db.get(FieldPhoto, photo_id)
    if not p or p.assessment_id != a.id:
        raise HTTPException(status_code=404, detail="Foto no encontrada")
    if os.path.exists(p.file_path):
        try:
            os.remove(p.file_path)
        except OSError:
            pass
    db.delete(p)
    db.commit()


# ── Sub-flujo B: triaje FEMA P-2018 ──────────────────────────────────────────


@router.post("/{assessment_id}/triage", response_model=AssessmentOut)
def run_or_update_triage(assessment_id: str, payload: TriageIn, user: CurrentUser, db: DB):
    """Calcula (o recalcula) el triaje FEMA P-2018 y persiste el resultado."""
    a = _get_or_404(db, assessment_id, user)

    if not a.snapshot or not a.snapshot.structural_system:
        raise HTTPException(
            status_code=400,
            detail="Falta el sistema estructural del edificio (snapshot).",
        )

    result = build_fema_triage(
        structural_system=a.snapshot.structural_system,
        exceptional_flags_json=payload.exceptional_flags,
        stories_json=payload.stories,
        shortcut_json=payload.shortcut,
        table_6_6_bands=payload.table_6_6_bands,
    )

    t = a.triage_result
    if t is None:
        t = TriageResult(assessment_id=a.id)
        db.add(t)

    t.applicability_ok = result.applicability_ok
    t.exceptional_flags_json = payload.exceptional_flags
    t.shortcut_applied = result.shortcut.applied if result.shortcut else None
    t.stories_json = payload.stories
    t.story_ratings_json = serialize_triage_stories(result)
    t.building_rating = result.building_rating
    t.decision = TriageDecisionModel(result.decision.value)
    t.decision_reason = result.decision_reason

    # Avanzar el stage si aplica.
    if a.stage != AssessmentStage.archived:
        a.stage = AssessmentStage.triage_done

    db.commit()
    db.refresh(a)
    return _serialize_assessment(a)


@router.delete("/{assessment_id}/triage", status_code=204)
def delete_triage(assessment_id: str, user: CurrentUser, db: DB):
    a = _get_or_404(db, assessment_id, user)
    if a.triage_result:
        db.delete(a.triage_result)
        # Retrocedemos a safety_done si teniamos triaje.
        if a.stage == AssessmentStage.triage_done:
            a.stage = AssessmentStage.safety_done
        db.commit()
