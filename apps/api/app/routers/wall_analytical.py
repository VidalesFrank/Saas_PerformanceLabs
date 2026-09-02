"""
Router — Wall Analytical Model API.

Manages E-SFI-MVLEM-3D (and other formulations) configuration per project.
The wall analytical config is stored inside the canonical model JSON under
  model["wall_analytical"] = {shell_label: wall_model_dict, ...}

Prefix: /api/v1/projects  (shared with structural_editor)
Auth:   JWT required.
"""
from __future__ import annotations

import json
import os
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import StructuralProject, User
from app.engine.building.walls import (
    WallFormulation,
    WallAnalyticalModel,
    ESFIMVLEM3DModel,
    MacroFiber,
    MacroFiberRegion,
    AutoDiscretization,
    BoundaryZone,
    WebZone,
    RCPanelMaterial,
    ConcreteMaterialDef,
    SteelMaterialDef,
    FSAMParams,
    MaterialRegistry,
    WallOpsGenerator,
    WallAnalyticalValidator,
    create_wall_model,
)

router = APIRouter(prefix="/api/v1/projects", tags=["wall-analytical"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project(project_id: str, user: User, db: Session) -> StructuralProject:
    p = db.query(StructuralProject).filter(
        StructuralProject.id == project_id,
        StructuralProject.owner_id == user.id,
    ).first()
    if not p:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    return p


def _load_canonical(project: StructuralProject) -> dict:
    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible.")
    with open(project.canonical_model_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_canonical(project: StructuralProject, model: dict) -> None:
    with open(project.canonical_model_path, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2, ensure_ascii=False)


def _wall_store(model: dict) -> dict:
    """Returns (and initialises if absent) the wall_analytical sub-dict."""
    if "wall_analytical" not in model:
        model["wall_analytical"] = {}
    return model["wall_analytical"]


def _wall_settings(model: dict) -> dict:
    """Global wall settings (default formulation, bulk config)."""
    if "wall_settings" not in model:
        model["wall_settings"] = {
            "default_formulation": WallFormulation.E_SFI_MVLEM_3D.value,
            "default_n_fibers":    8,
            "default_c_rot":       0.4,
            "default_thick_mod":   0.63,
            "default_poisson":     0.25,
        }
    return model["wall_settings"]


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class BoundaryZoneIn(BaseModel):
    width_m:        float
    thickness_m:    float = 0.0
    rho_vertical:   float
    rho_horizontal: float = 0.0
    concrete_name:  str = ""
    steel_v_name:   str = ""
    steel_h_name:   str = ""


class WebZoneIn(BaseModel):
    thickness_m:    float
    rho_vertical:   float
    rho_horizontal: float
    concrete_name:  str = ""
    steel_v_name:   str = ""
    steel_h_name:   str = ""


class AutoDiscretizeRequest(BaseModel):
    wall_length_m:    float
    wall_thickness_m: float
    left_boundary:    BoundaryZoneIn | None = None
    web:              WebZoneIn
    right_boundary:   BoundaryZoneIn | None = None
    n_fibers:         int = Field(default=8, ge=2, le=40)
    formulation:      str = WallFormulation.E_SFI_MVLEM_3D.value
    node_i:           str = ""
    node_j:           str = ""
    node_k:           str = ""
    node_l:           str = ""
    c_rot:            float = 0.4
    thick_mod:        float = 0.63
    poisson:          float = 0.25
    density_t_m3:     float = 2.4
    source_pier:      str = ""
    source_story:     str = ""


class WallModelIn(BaseModel):
    """Full wall analytical model dict (from_dict / to_dict round-trip)."""
    formulation:  str
    nodes:        list[str]
    macrofibers:  list[dict]
    density_t_m3: float = 2.4
    source_pier:  str = ""
    source_story: str = ""
    c_rot:        float = 0.4
    thick_mod:    float = 0.63
    poisson:      float = 0.25


class BulkAssignRequest(BaseModel):
    wall_labels:  list[str]
    formulation:  str = WallFormulation.E_SFI_MVLEM_3D.value
    n_fibers:     int = Field(default=8, ge=2, le=40)
    c_rot:        float = 0.4
    thick_mod:    float = 0.63
    poisson:      float = 0.25


class WallSettingsIn(BaseModel):
    default_formulation: str = WallFormulation.E_SFI_MVLEM_3D.value
    default_n_fibers:    int = 8
    default_c_rot:       float = 0.4
    default_thick_mod:   float = 0.63
    default_poisson:     float = 0.25


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/walls/settings")
def get_wall_settings(project_id: str, user: CurrentUser, db: DB):
    """Return global wall analytical settings for the project."""
    proj = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    return _wall_settings(model)


@router.put("/{project_id}/walls/settings")
def update_wall_settings(
    project_id: str, body: WallSettingsIn, user: CurrentUser, db: DB
):
    proj = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    settings = _wall_settings(model)
    settings.update(body.model_dump())
    _save_canonical(proj, model)
    return settings


@router.get("/{project_id}/walls")
def list_walls(project_id: str, user: CurrentUser, db: DB):
    """
    List all wall shells from the canonical model with their analytical config (if set).
    """
    proj = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    shells = model.get("shells", {})
    wall_store = _wall_store(model)

    walls_out = []
    for label, shell in shells.items():
        if shell.get("element_type") != "wall":
            continue
        analytical = wall_store.get(label)
        walls_out.append({
            "label":        label,
            "story":        shell.get("story", ""),
            "area_label":   shell.get("area_label", label),
            "joints":       shell.get("joints", []),
            "section":      shell.get("section", ""),
            "thickness_m":  shell.get("thickness_m", 0.0),
            "has_analytical": analytical is not None,
            "formulation":  analytical.get("formulation") if analytical else None,
            "n_fibers":     analytical.get("n_fibers") if analytical else None,
            "source_pier":  analytical.get("source_pier", "") if analytical else "",
            "source_story": analytical.get("source_story", "") if analytical else "",
        })

    configured   = sum(1 for w in walls_out if w["has_analytical"])
    incomplete   = sum(
        1 for w in walls_out
        if w["has_analytical"] and (w["n_fibers"] or 0) < 2
    )

    return {
        "walls":      walls_out,
        "total":      len(walls_out),
        "configured": configured,
        "incomplete": incomplete,
        "invalid":    0,
    }


@router.get("/{project_id}/walls/health")
def wall_health(project_id: str, user: CurrentUser, db: DB):
    """
    Model health summary for all walls (point 24 of spec).
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    shells = model.get("shells", {})
    store  = _wall_store(model)
    joints = model.get("joints", {})
    validator = WallAnalyticalValidator()

    total = configured = incomplete = invalid = warnings = 0
    issues: list[dict] = []

    for label, shell in shells.items():
        if shell.get("element_type") != "wall":
            continue
        total += 1
        if label not in store:
            incomplete += 1
            continue
        configured += 1
        try:
            form = WallFormulation(store[label]["formulation"])
            wm   = create_wall_model(form, store[label])
            result = validator.validate(wm, joints)
            if not result.is_valid:
                invalid += 1
                for e in result.errors:
                    issues.append({"label": label, "code": e.code, "message": e.message})
            warnings += len(result.warnings)
        except Exception as exc:
            invalid += 1
            issues.append({"label": label, "code": "PARSE_ERROR", "message": str(exc)})

    return {
        "total":      total,
        "configured": configured,
        "incomplete": incomplete,
        "invalid":    invalid,
        "warnings":   warnings,
        "issues":     issues[:50],
    }


@router.post("/{project_id}/walls/bulk-assign")
def bulk_assign_formulation(
    project_id: str,
    body: BulkAssignRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Assign a formulation and default parameters to multiple wall shells at once.
    Existing analytical model data is preserved; only formulation/params are updated.
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    store = _wall_store(model)
    shells = model.get("shells", {})

    updated = []
    skipped = []
    for label in body.wall_labels:
        if label not in shells or shells[label].get("element_type") != "wall":
            skipped.append(label)
            continue
        existing = store.get(label, {})
        existing.update({
            "formulation": body.formulation,
            "c_rot":       body.c_rot,
            "thick_mod":   body.thick_mod,
            "poisson":     body.poisson,
        })
        if not existing.get("nodes"):
            sh = shells[label]
            jts = sh.get("joints", [])
            existing["nodes"] = jts[:4] if len(jts) >= 4 else ["", "", "", ""]
        if not existing.get("macrofibers"):
            existing["macrofibers"] = []
            existing["n_fibers"] = body.n_fibers
        store[label] = existing
        updated.append(label)

    _save_canonical(proj, model)
    return {"updated": len(updated), "skipped": len(skipped), "labels": updated}


@router.get("/{project_id}/walls/{wall_label}")
def get_wall(project_id: str, wall_label: str, user: CurrentUser, db: DB):
    """Get the analytical model for a specific wall shell."""
    proj = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    shells = model.get("shells", {})
    if wall_label not in shells:
        raise HTTPException(status_code=404, detail=f"Shell '{wall_label}' not found")
    shell = shells[wall_label]
    wall_store = _wall_store(model)
    return {
        "label":      wall_label,
        "shell":      shell,
        "analytical": wall_store.get(wall_label),
    }


@router.post("/{project_id}/walls/{wall_label}/auto-discretize")
def auto_discretize_wall(
    project_id: str,
    wall_label: str,
    body: AutoDiscretizeRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Generate macrofiber discretization for a wall from physical zone definitions.
    Saves the result to the canonical model.
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)

    lb = None
    if body.left_boundary:
        b = body.left_boundary
        lb = BoundaryZone(
            width_m=b.width_m, thickness_m=b.thickness_m or body.wall_thickness_m,
            rho_vertical=b.rho_vertical, rho_horizontal=b.rho_horizontal,
            concrete_name=b.concrete_name, steel_v_name=b.steel_v_name,
            steel_h_name=b.steel_h_name,
        )
    rb = None
    if body.right_boundary:
        b = body.right_boundary
        rb = BoundaryZone(
            width_m=b.width_m, thickness_m=b.thickness_m or body.wall_thickness_m,
            rho_vertical=b.rho_vertical, rho_horizontal=b.rho_horizontal,
            concrete_name=b.concrete_name, steel_v_name=b.steel_v_name,
            steel_h_name=b.steel_h_name,
        )
    w = body.web
    web = WebZone(
        thickness_m=w.thickness_m or body.wall_thickness_m,
        rho_vertical=w.rho_vertical, rho_horizontal=w.rho_horizontal,
        concrete_name=w.concrete_name, steel_v_name=w.steel_v_name,
        steel_h_name=w.steel_h_name,
    )

    form = WallFormulation(body.formulation)

    wall_model = ESFIMVLEM3DModel.from_physical_wall(
        node_i=body.node_i, node_j=body.node_j,
        node_k=body.node_k, node_l=body.node_l,
        wall_length_m=body.wall_length_m,
        wall_thickness_m=body.wall_thickness_m,
        left_boundary=lb, web=web, right_boundary=rb,
        n_fibers=body.n_fibers,
        c_rot=body.c_rot, thick_mod=body.thick_mod, poisson=body.poisson,
        density_t_m3=body.density_t_m3,
        source_pier=body.source_pier, source_story=body.source_story,
    )
    # Override formulation if user chose SFI or MVLEM
    if form != WallFormulation.E_SFI_MVLEM_3D:
        wall_model.formulation = form

    wall_dict = wall_model.to_dict()
    _wall_store(model)[wall_label] = wall_dict
    _save_canonical(proj, model)
    return wall_dict


@router.put("/{project_id}/walls/{wall_label}")
def save_wall_model(
    project_id: str,
    wall_label: str,
    body: WallModelIn,
    user: CurrentUser,
    db: DB,
):
    """Save or replace the analytical model for a wall (round-trip from UI)."""
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)

    try:
        form = WallFormulation(body.formulation)
        wall_model = create_wall_model(form, body.model_dump())
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    _wall_store(model)[wall_label] = wall_model.to_dict()
    _save_canonical(proj, model)
    return wall_model.to_dict()


@router.delete("/{project_id}/walls/{wall_label}/analytical")
def delete_wall_analytical(
    project_id: str, wall_label: str, user: CurrentUser, db: DB
):
    """Remove the analytical model for a wall (resets to unconfigured)."""
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    store = _wall_store(model)
    if wall_label not in store:
        raise HTTPException(status_code=404, detail="No analytical model found for this wall")
    del store[wall_label]
    _save_canonical(proj, model)
    return {"deleted": wall_label}


@router.get("/{project_id}/walls/{wall_label}/validate")
def validate_wall(project_id: str, wall_label: str, user: CurrentUser, db: DB):
    """Run analytical model validation checks for a wall."""
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    store = _wall_store(model)
    if wall_label not in store:
        raise HTTPException(status_code=404, detail="Wall has no analytical model configured")

    form = WallFormulation(store[wall_label]["formulation"])
    wall_model = create_wall_model(form, store[wall_label])
    joints = model.get("joints", {})
    result = WallAnalyticalValidator().validate(wall_model, joints)
    return result.to_dict()


@router.get("/{project_id}/walls/{wall_label}/preview-ops")
def preview_openseespy(
    project_id: str, wall_label: str, user: CurrentUser, db: DB
):
    """Return the OpenSeesPy command text that would be generated for this wall."""
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    store = _wall_store(model)
    if wall_label not in store:
        raise HTTPException(status_code=404, detail="Wall has no analytical model configured")

    form = WallFormulation(store[wall_label]["formulation"])
    wall_model = create_wall_model(form, store[wall_label])

    joints = model.get("joints", {})
    node_tag_map = {jid: idx + 1 for idx, jid in enumerate(sorted(joints.keys()))}

    materials  = model.get("materials", {})
    c_props = {name: {"fpc_mpa": mat.get("fpc_mpa", 28.0)} for name, mat in materials.items()}

    gen = WallOpsGenerator(
        registry=MaterialRegistry(),
        node_tag_map=node_tag_map,
        concrete_props=c_props,
    )
    preview = gen.preview_text(wall_model, wall_key=wall_label)
    return {"preview": preview}


