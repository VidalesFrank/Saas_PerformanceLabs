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
from app.models import (
    StructuralProject,
    User,
    StructuralJob,
    StructuralAnalysisType,
    StructuralJobStatus,
)
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
from app.engine.building.walls.wall_design_engine import compute_wall_design
from app.engine.building.walls.wall_design_schemas import (
    WallDemandCombo,
    WallReinforcement,
    BoundaryZoneReinf,
    WebZoneReinf,
    curtains_for_tw,
)
from app.engine.building.walls.auto_design import WallNotDesignableError

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


# ── Aggregated section detail ─────────────────────────────────────────────────

def _geometry_from_macrofibers(macrofibers: list[dict]) -> dict:
    """Sum widths per region → boundary/web split for the section view."""
    lb = sum(mf["width_m"] for mf in macrofibers if mf["region"] == "boundary_left")
    rb = sum(mf["width_m"] for mf in macrofibers if mf["region"] == "boundary_right")
    web = sum(mf["width_m"] for mf in macrofibers if mf["region"] == "web")
    thickness = macrofibers[0]["thickness_m"] if macrofibers else 0.0
    return {
        "total_length_m":    round(lb + web + rb, 6),
        "boundary_left_m":   round(lb, 6),
        "web_m":             round(web, 6),
        "boundary_right_m":  round(rb, 6),
        "thickness_m":       round(thickness, 6),
    }


@router.get("/{project_id}/walls/{wall_label}/detail")
def wall_detail(
    project_id: str, wall_label: str, user: CurrentUser, db: DB,
):
    """
    Aggregated detail for the "premium" wall section view.
    Returns geometry + macrofibers + reinforcement + OpenSees mapping in one request.
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    shells = model.get("shells", {})
    if wall_label not in shells:
        raise HTTPException(status_code=404, detail=f"Shell '{wall_label}' not found")

    shell = shells[wall_label]
    if shell.get("element_type") != "wall":
        raise HTTPException(status_code=400, detail=f"Shell '{wall_label}' is not a wall")

    store = _wall_store(model)
    analytical_dict = store.get(wall_label)
    joints_all = model.get("joints", {})

    # Node coords for the 4 corners (may be empty strings if unassigned)
    shell_joints = shell.get("joints", [])
    node_coords: dict[str, dict[str, float] | None] = {}
    for jid in shell_joints[:4]:
        j = joints_all.get(jid)
        if j is None:
            node_coords[jid] = None
        else:
            node_coords[jid] = {
                "x": float(j.get("x", 0.0)),
                "y": float(j.get("y", 0.0)),
                "z": float(j.get("z", 0.0)),
            }

    # ── Physical geometry from pier_geom (independent of analytical config) ──
    pier_key: str | None = None
    pier  = shell.get("pier")  or shell.get("source_pier")
    story = shell.get("story") or shell.get("source_story")
    if pier and story:
        pier_key = f"{pier}|{story}"

    physical_geom: dict | None = None
    if pier_key:
        wd_json = _latest_wall_demands(proj, db)
        pier_geom_all = (wd_json or {}).get("pier_geom") or _reconstruct_pier_geom(proj, model)
        pg = pier_geom_all.get(pier_key) if pier_geom_all else None
        if pg:
            physical_geom = {
                "lw_m":   float(pg.get("lw", 0.0)),
                "tw_m":   float(pg.get("tw", 0.0)),
                "hw_m":   float(pg.get("hw", 0.0)),
                "fc_mpa": float(pg.get("fc_mpa", 28.0)),
                "pier":   pier,
                "story":  story,
            }

    response: dict = {
        "label":            wall_label,
        "shell":            shell,
        "node_coords":      node_coords,
        "physical_geom":    physical_geom,
        "has_analytical":   analytical_dict is not None,
        "analytical":       analytical_dict,
        "formulation_info": None,
        "geometry":         None,
        "opensees":         None,
        "materials_registry": None,
    }

    # Geometry summary from macrofibers (if analytical present) or from
    # physical geom / design result (fallback for panel pre-fill)
    if analytical_dict:
        form = WallFormulation(analytical_dict["formulation"])
        response["formulation_info"] = {
            "value":         form.value,
            "label":         form.label,
            "description":   form.description,
            "uses_rc_panel": form.uses_rc_panel,
        }
        response["geometry"] = _geometry_from_macrofibers(analytical_dict.get("macrofibers", []))
    elif physical_geom:
        # Fall back to plain physical geometry — will be augmented if design exists
        response["geometry"] = {
            "total_length_m":   physical_geom["lw_m"],
            "boundary_left_m":  0.0,
            "web_m":            physical_geom["lw_m"],
            "boundary_right_m": 0.0,
            "thickness_m":      physical_geom["tw_m"],
        }

    if analytical_dict is None:
        # Even without analytical, expose design_result + demands
        design_store = model.get("wall_design", {})
        design_result = design_store.get(wall_label)
        response["design_result"]  = design_result
        response["design_demands"] = _demands_used_for(model, wall_label)
        # If design exists, replace fallback geometry with actual boundary split
        if design_result:
            r = design_result.get("reinforcement", {})
            g = design_result.get("geometry", {})
            lw = float(g.get("lw_m", response["geometry"]["total_length_m"] if response["geometry"] else 0))
            lL = float(r.get("be_left",  {}).get("length_m", 0.0))
            lR = float(r.get("be_right", {}).get("length_m", 0.0))
            response["geometry"] = {
                "total_length_m":   lw,
                "boundary_left_m":  lL,
                "web_m":            max(lw - lL - lR, 0.0),
                "boundary_right_m": lR,
                "thickness_m":      float(g.get("tw_m", physical_geom["tw_m"] if physical_geom else 0.0)),
            }
        return response

    # OpenSees mapping — rebuild registry + ops generator
    wall_model = create_wall_model(form, analytical_dict)
    node_tag_map = {jid: idx + 1 for idx, jid in enumerate(sorted(joints_all.keys()))}

    materials  = model.get("materials", {})
    c_props = {name: {"fpc_mpa": mat.get("fpc_mpa", 28.0)} for name, mat in materials.items()}
    s_props = {
        name: {"fy_mpa": mat.get("fy_mpa", 420.0), "E_mpa": mat.get("E_mpa", 200_000.0)}
        for name, mat in materials.items()
    }

    registry = MaterialRegistry()
    gen = WallOpsGenerator(
        registry=registry,
        node_tag_map=node_tag_map,
        concrete_props=c_props,
        steel_props=s_props,
    )
    ops_result = gen.generate(wall_model, wall_key=wall_label)

    nodes_list = analytical_dict.get("nodes", ["", "", "", ""])
    response["opensees"] = {
        "ele_tag":        ops_result["ele_tag"],
        "mat_tags":       ops_result["mat_tags"],
        "material_lines": ops_result["material_lines"],
        "element_line":   ops_result["element_line"],
        "node_ids": {
            "i": nodes_list[0] if len(nodes_list) > 0 else "",
            "j": nodes_list[1] if len(nodes_list) > 1 else "",
            "k": nodes_list[2] if len(nodes_list) > 2 else "",
            "l": nodes_list[3] if len(nodes_list) > 3 else "",
        },
        "node_tags": {
            "i": node_tag_map.get(nodes_list[0], 0) if len(nodes_list) > 0 else 0,
            "j": node_tag_map.get(nodes_list[1], 0) if len(nodes_list) > 1 else 0,
            "k": node_tag_map.get(nodes_list[2], 0) if len(nodes_list) > 2 else 0,
            "l": node_tag_map.get(nodes_list[3], 0) if len(nodes_list) > 3 else 0,
        },
    }

    response["materials_registry"] = registry.to_dict()

    # ── Diseño guardado (si existe) ──────────────────────────────────────────
    design_store = model.get("wall_design", {})
    response["design_result"]  = design_store.get(wall_label)
    response["design_demands"] = _demands_used_for(model, wall_label)

    return response


# ═════════════════════════════════════════════════════════════════════════════
# Auto-diseño de refuerzo — orquesta wall_demands → compute_wall_design
# ═════════════════════════════════════════════════════════════════════════════

def _latest_wall_demands(project: StructuralProject, db: Session) -> dict | None:
    """Loads the most recent successful wall_demands JSON payload, or None."""
    job = (
        db.query(StructuralJob)
        .filter(
            StructuralJob.project_id     == project.id,
            StructuralJob.analysis_type  == StructuralAnalysisType.wall_demands,
            StructuralJob.status         == StructuralJobStatus.success,
        )
        .order_by(StructuralJob.created_at.desc())
        .first()
    )
    if job is None or not job.result_path or not os.path.exists(job.result_path):
        return None
    try:
        with open(job.result_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _resolve_xlsx_path(project: StructuralProject) -> str | None:
    """
    Locates the XLSX used at import time — same fallback logic as
    structural_wall_demands_task: input_file_path if it exists and is xlsx,
    otherwise <work_dir>/input/input_model.xlsx.
    """
    xlsx = project.input_file_path
    is_xlsx = lambda p: bool(p) and p.lower().endswith((".xls", ".xlsx", ".xlsm"))
    if is_xlsx(xlsx) and os.path.exists(xlsx):
        return xlsx
    if project.canonical_model_path:
        work_dir  = os.path.dirname(os.path.dirname(project.canonical_model_path))
        candidate = os.path.join(work_dir, "input", "input_model.xlsx")
        if os.path.exists(candidate):
            return candidate
    return None


def _reconstruct_pier_geom(project: StructuralProject, model: dict) -> dict[str, dict]:
    """
    Rebuilds pier_geom (keyed 'pier|story') without running OpenSees.
    Requires the XLSX generated at import time.
    """
    from app.engine.building.linear.wall_model_builder import WallModelBuilder
    from app.tasks.structural_wall_demands_task import _load_wall_raw_data

    xlsx = _resolve_xlsx_path(project)
    if xlsx is None:
        return {}

    raw_data = _load_wall_raw_data(xlsx)
    try:
        wb   = WallModelBuilder(model, raw_data, n_fibers=8)
        geom = wb.extract_pier_geometry_only()
    except Exception:
        return {}
    return {f"{p}|{s}": g for (p, s), g in geom.items()}


def _pier_geom_by_wall_label(
    model: dict, pier_geom: dict[str, dict],
) -> dict[str, tuple[str, dict]]:
    """
    Maps shell label → (pier|story key, geom dict).
    A wall shell in the canonical carries source_pier/source_story via ETABS
    pier assignments; if absent we fall back to matching by (shell.pier, shell.story).
    """
    out: dict[str, tuple[str, dict]] = {}
    shells = model.get("shells", {})
    for label, shell in shells.items():
        if shell.get("element_type") != "wall":
            continue
        pier  = shell.get("pier")  or shell.get("source_pier")
        story = shell.get("story") or shell.get("source_story")
        if not pier or not story:
            continue
        key = f"{pier}|{story}"
        if key in pier_geom:
            out[label] = (key, pier_geom[key])
    return out


def _demands_for_pier(pier_demands: list[dict], pier: str, story: str) -> list[dict]:
    return [d for d in pier_demands if d.get("pier") == pier and d.get("story") == story]


def _wall_axis(g: dict) -> str:
    """Returns 'X', 'Y' or 'inclined' based on pier orientation."""
    dx = abs(g.get("x2", 0.0) - g.get("x1", 0.0))
    dy = abs(g.get("y2", 0.0) - g.get("y1", 0.0))
    if dx > 5 * dy:
        return "X"
    if dy > 5 * dx:
        return "Y"
    return "inclined"


def _to_wall_demand_combo(d: dict, axis: str) -> WallDemandCombo:
    """
    Maps a pier_demands row to a WallDemandCombo picking the in-plane V/M.
    Axis-oriented walls use their principal V/M; inclined walls use envelope.
    """
    Pu = float(d.get("Pu_kN", 0.0))
    if axis == "X":
        Vu = abs(float(d.get("Vu_x_kN", 0.0)))
        Mu = abs(float(d.get("Mu_y_kNm", 0.0)))
    elif axis == "Y":
        Vu = abs(float(d.get("Vu_y_kN", 0.0)))
        Mu = abs(float(d.get("Mu_x_kNm", 0.0)))
    else:
        Vu = max(abs(float(d.get("Vu_x_kN", 0.0))), abs(float(d.get("Vu_y_kN", 0.0))))
        Mu = max(abs(float(d.get("Mu_x_kNm", 0.0))), abs(float(d.get("Mu_y_kNm", 0.0))))
    label = str(d.get("combo", ""))
    is_seismic = "E" in label
    return WallDemandCombo(
        label=label,
        Pu_kN=Pu,
        Vu_kN=Vu,
        Mu_kNm=Mu,
        is_seismic=is_seismic,
    )


def _demands_used_for(model: dict, wall_label: str) -> list[dict] | None:
    """
    Reads the cached demands snapshot stored alongside the design for this
    wall. Written by /auto-design-all and /design; None if no design run yet.
    """
    store = model.get("wall_design_meta", {})
    return store.get(wall_label, {}).get("demands")


def _wall_design_ductility(model: dict) -> str:
    """DES / DMO from project parameters if present, else DES."""
    seis = model.get("seismic_params", {}) or model.get("parameters", {})
    d = str(seis.get("ductility", "DES")).upper()
    return d if d in ("DES", "DMO") else "DES"


class AutoDesignAllRequest(BaseModel):
    ductility:   str | None = None          # "DES" | "DMO" — overrides project default
    cover_mm:    float = 40.0
    fyt_mpa:     float = 420.0              # yield strength of transverse steel
    delta_u_hw:  float | None = None        # inelastic roof drift ratio (for EBE-displacement)


@router.post("/{project_id}/walls/auto-design-all")
def auto_design_all(
    project_id: str,
    body: AutoDesignAllRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Runs auto-design (compute_wall_design mode='auto') for every wall shell
    that has computed demands. Writes model["wall_design"][label] with the
    full WallDesignResult dict. Returns a summary of successes and failures.
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)

    wd_json = _latest_wall_demands(proj, db)
    if wd_json is None:
        raise HTTPException(
            status_code=400,
            detail="No hay resultado exitoso de wall_demands. Corre primero el análisis de demandas.",
        )
    pier_demands = wd_json.get("pier_demands") or []

    # Get pier_geom — prefer serialized in wall_demands, else reconstruct
    pier_geom = wd_json.get("pier_geom") or _reconstruct_pier_geom(proj, model)
    if not pier_geom:
        raise HTTPException(
            status_code=500,
            detail="No se pudo obtener la geometría de los muros (pier_geom).",
        )

    wall_map = _pier_geom_by_wall_label(model, pier_geom)
    if not wall_map:
        raise HTTPException(
            status_code=400,
            detail="No hay shells de muro asociados a un (pier, story) con geometría.",
        )

    ductility = (body.ductility or _wall_design_ductility(model)).upper()
    if ductility not in ("DES", "DMO"):
        ductility = "DES"

    designed:  list[str] = []
    failed:    list[dict] = []
    total_walls = len(wall_map)

    if "wall_design"      not in model: model["wall_design"]      = {}
    if "wall_design_meta" not in model: model["wall_design_meta"] = {}

    def _drop_stale(lbl: str) -> None:
        """Elimina diseño obsoleto del canonical cuando el nuevo cálculo falla."""
        model["wall_design"].pop(lbl, None)
        model["wall_design_meta"].pop(lbl, None)

    for label, (key, g) in wall_map.items():
        pier, story = key.split("|", 1)
        rows = _demands_for_pier(pier_demands, pier, story)
        if not rows:
            failed.append({"label": label, "reason": "sin combos de demanda"})
            _drop_stale(label)
            continue

        axis    = _wall_axis(g)
        demands = [_to_wall_demand_combo(r, axis) for r in rows]

        lw = float(g.get("lw", 0.0))
        tw = float(g.get("tw", 0.0))
        hw = float(g.get("hw", 0.0))
        fc = float(g.get("fc_mpa", 28.0))
        # Try to pick fy of first steel material of project, else 420
        materials = model.get("materials", {})
        fy = 420.0
        for m in materials.values():
            if m.get("kind", "").lower() == "steel" or "fy_mpa" in m:
                fy = float(m.get("fy_mpa", 420.0))
                break

        if lw <= 0 or tw <= 0 or hw <= 0:
            failed.append({"label": label, "reason": f"geometría inválida (lw={lw}, tw={tw}, hw={hw})"})
            _drop_stale(label)
            continue

        try:
            result = compute_wall_design(
                lw_m=lw, tw_m=tw, hw_m=hw,
                fc_mpa=fc, fy_mpa=fy, fyt_mpa=body.fyt_mpa,
                ductility=ductility,
                demands=demands,
                mode="auto",
                cover_mm=body.cover_mm,
                delta_u_hw=body.delta_u_hw,
            )
        except WallNotDesignableError as exc:
            failed.append({"label": label, "reason": f"no diseñable — {exc}"})
            _drop_stale(label)
            continue
        except Exception as exc:
            failed.append({"label": label, "reason": f"engine error: {exc}"})
            _drop_stale(label)
            continue

        model["wall_design"][label] = result
        model["wall_design_meta"][label] = {
            "pier":       pier,
            "story":      story,
            "axis":       axis,
            "ductility":  ductility,
            "fc_mpa":     fc,
            "fy_mpa":     fy,
            "fyt_mpa":    body.fyt_mpa,
            "cover_mm":   body.cover_mm,
            "geometry":   {"lw_m": lw, "tw_m": tw, "hw_m": hw},
            "demands":    [
                {
                    "label":      d.label,
                    "Pu_kN":      d.Pu_kN,
                    "Vu_kN":      d.Vu_kN,
                    "Mu_kNm":     d.Mu_kNm,
                    "is_seismic": d.is_seismic,
                }
                for d in demands
            ],
        }
        designed.append(label)

    _save_canonical(proj, model)

    return {
        "designed_count": len(designed),
        "failed_count":   len(failed),
        "total_walls":    total_walls,
        "designed":       designed,
        "failed":         failed,
        "ductility":      ductility,
    }


@router.get("/{project_id}/walls/{wall_label}/design")
def get_wall_design(project_id: str, wall_label: str, user: CurrentUser, db: DB):
    """Return the persisted design result for a single wall (if any)."""
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)
    result = model.get("wall_design", {}).get(wall_label)
    if result is None:
        raise HTTPException(status_code=404, detail="No design result stored for this wall.")
    return {
        "label":   wall_label,
        "result":  result,
        "meta":    model.get("wall_design_meta", {}).get(wall_label),
    }


class WallDesignManualIn(BaseModel):
    # Same fields as compute endpoint, minus geometry/materials (taken from stored meta)
    ductility:   str | None = None
    cover_mm:    float = 40.0
    fyt_mpa:     float = 420.0
    delta_u_hw:  float | None = None
    # Manual reinforcement (optional — if absent, re-runs auto)
    manual_reinf: dict | None = None


@router.post("/{project_id}/walls/{wall_label}/design")
def redesign_wall(
    project_id: str,
    wall_label: str,
    body: WallDesignManualIn,
    user: CurrentUser,
    db: DB,
):
    """
    Recalculate the design for a single wall. If `manual_reinf` is provided,
    uses mode="manual" so the engine verifies the given reinforcement.
    Otherwise re-runs the auto design.
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)

    meta = model.get("wall_design_meta", {}).get(wall_label)
    if meta is None:
        raise HTTPException(
            status_code=400,
            detail="El muro no tiene diseño previo — corre auto-design-all primero.",
        )

    demands = [
        WallDemandCombo(
            label=d["label"],
            Pu_kN=d["Pu_kN"], Vu_kN=d["Vu_kN"], Mu_kNm=d["Mu_kNm"],
            is_seismic=d.get("is_seismic", True),
        )
        for d in meta.get("demands", [])
    ]
    if not demands:
        raise HTTPException(status_code=422, detail="Meta de diseño sin combos guardados.")

    geom = meta["geometry"]
    ductility = (body.ductility or meta.get("ductility") or "DES").upper()

    manual_reinf: WallReinforcement | None = None
    mode = "auto"
    if body.manual_reinf:
        mode = "manual"
        mr = body.manual_reinf
        tw_m = float(geom["tw_m"])
        n_cur = curtains_for_tw(tw_m)
        try:
            # Fuerza n_curtains por regla geométrica (tw); ignora lo que envíe el cliente.
            be_l_dict = {**mr["be_left"],  "n_curtains": n_cur}
            web_dict  = {**mr["web"],       "n_curtains": n_cur}
            be_r_dict = {**mr["be_right"], "n_curtains": n_cur}
            manual_reinf = WallReinforcement(
                be_left=BoundaryZoneReinf(**be_l_dict),
                web=WebZoneReinf(**web_dict),
                be_right=BoundaryZoneReinf(**be_r_dict),
                symmetric=mr.get("symmetric", True),
            )
        except (KeyError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=f"manual_reinf inválido: {exc}")

    try:
        result = compute_wall_design(
            lw_m=geom["lw_m"], tw_m=geom["tw_m"], hw_m=geom["hw_m"],
            fc_mpa=meta["fc_mpa"], fy_mpa=meta["fy_mpa"], fyt_mpa=body.fyt_mpa,
            ductility=ductility,
            demands=demands,
            mode=mode,
            manual_reinf=manual_reinf,
            cover_mm=body.cover_mm,
            delta_u_hw=body.delta_u_hw,
        )
    except WallNotDesignableError as exc:
        raise HTTPException(status_code=422, detail=f"Muro no diseñable en automático — {exc}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    model["wall_design"][wall_label] = result
    meta.update({
        "ductility":  ductility,
        "cover_mm":   body.cover_mm,
        "fyt_mpa":    body.fyt_mpa,
        "mode":       mode,
    })
    _save_canonical(proj, model)

    return {"label": wall_label, "result": result, "meta": meta}


# ═════════════════════════════════════════════════════════════════════════════
# Pipeline instantáneo: diseña + construye MVLEM en un solo paso
# ═════════════════════════════════════════════════════════════════════════════

def _reinforcement_to_zones(
    result: dict, tw_m: float,
    concrete_name: str, steel_name: str,
):
    """
    Traduce el WallDesignResult a BoundaryZone|None + WebZone + BoundaryZone|None
    para alimentar ESFIMVLEM3DModel.from_physical_wall.

    Cuando el diseño no requiere EBE (be_left/be_right vacíos), retorna
    (None, WebZone que ocupa todo lw, None) — el modelo MVLEM se arma con una
    sola zona de refuerzo distribuido.

    Convenciones documentadas en walls/DESIGN_TO_MVLEM.md.
    """
    from app.engine.building.walls.wall_design_schemas import bar_area

    r = result["reinforcement"]
    be_l_data = r["be_left"]
    be_r_data = r["be_right"]
    web_data  = r["web"]

    def _is_empty(be: dict) -> bool:
        return be.get("n_bars", 0) <= 0 or be.get("length_m", 0.0) <= 0.0

    def _rho_be_v(be: dict) -> float:
        n_cur = be.get("n_curtains", curtains_for_tw(tw_m))
        As = be["n_bars"] * n_cur * bar_area(be["db_mm"])
        return As / (be["length_m"] * tw_m * 1e6)

    def _rho_be_h(be: dict) -> float:
        n_legs = be.get("n_legs_h", 2)
        As_tie = bar_area(be["tie_db_mm"])
        return n_legs * As_tie / (tw_m * be["tie_spacing_mm"] / 1000 * 1e6)

    # ρᵥ_web / ρₕ_web (refuerzo del alma, siempre presente)
    n_cur_web = web_data.get("n_curtains", curtains_for_tw(tw_m))
    As_v_web  = bar_area(web_data["vert_db_mm"])
    As_h_web  = bar_area(web_data["horiz_db_mm"])
    rho_v_web = n_cur_web * As_v_web / (tw_m * web_data["vert_spacing_mm"]  / 1000 * 1e6)
    rho_h_web = n_cur_web * As_h_web / (tw_m * web_data["horiz_spacing_mm"] / 1000 * 1e6)

    web = WebZone(
        thickness_m=tw_m,
        rho_vertical=rho_v_web,
        rho_horizontal=rho_h_web,
        concrete_name=concrete_name,
        steel_v_name=steel_name, steel_h_name=steel_name,
    )

    lb = None if _is_empty(be_l_data) else BoundaryZone(
        width_m=be_l_data["length_m"], thickness_m=tw_m,
        rho_vertical=_rho_be_v(be_l_data),
        rho_horizontal=_rho_be_h(be_l_data),
        concrete_name=concrete_name,
        steel_v_name=steel_name, steel_h_name=steel_name,
    )
    rb = None if _is_empty(be_r_data) else BoundaryZone(
        width_m=be_r_data["length_m"], thickness_m=tw_m,
        rho_vertical=_rho_be_v(be_r_data),
        rho_horizontal=_rho_be_h(be_r_data),
        concrete_name=concrete_name,
        steel_v_name=steel_name, steel_h_name=steel_name,
    )

    return lb, web, rb


class DesignAndBuildAllRequest(BaseModel):
    ductility:      str | None = None      # DES|DMO — overrides projects default
    cover_mm:       float = 40.0
    fyt_mpa:        float = 420.0
    delta_u_hw:     float | None = None
    # Discretization
    width_max_m:    float = 0.30           # ancho máx por macrofibra (default 0.30 m)
    n_fibers:       int   = 0              # si > 0, ignora width_max_m
    formulation:    str = "E_SFI_MVLEM_3D"
    c_rot:          float = 0.4
    thick_mod:      float = 0.63
    poisson:        float = 0.25


@router.post("/{project_id}/walls/design-and-build-all")
def design_and_build_all(
    project_id: str,
    body: DesignAndBuildAllRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Pipeline "un click": diseña refuerzo NSR-10/ACI + arma MVLEM_3D con macrofibras
    derivadas del refuerzo, para TODOS los muros del proyecto con demandas guardadas.

    Salida por muro en canonical:
      wall_design[label]      = WallDesignResult
      wall_design_meta[label] = metadata
      wall_analytical[label]  = WallAnalyticalModel con macrofibras del refuerzo real
    """
    proj  = _get_project(project_id, user, db)
    model = _load_canonical(proj)

    wd_json = _latest_wall_demands(proj, db)
    if wd_json is None:
        raise HTTPException(400, "No hay wall_demands. Corre primero el análisis de demandas.")

    pier_demands = wd_json.get("pier_demands") or []
    pier_geom    = wd_json.get("pier_geom") or _reconstruct_pier_geom(proj, model)
    if not pier_geom:
        raise HTTPException(500, "No se pudo obtener pier_geom.")

    wall_map = _pier_geom_by_wall_label(model, pier_geom)
    if not wall_map:
        raise HTTPException(400, "No hay shells de muro asociados a pieres con geometría.")

    ductility = (body.ductility or _wall_design_ductility(model)).upper()
    if ductility not in ("DES", "DMO"):
        ductility = "DES"

    try:
        form = WallFormulation(body.formulation)
    except ValueError:
        raise HTTPException(422, f"Formulación inválida: {body.formulation}")

    # Determinar materiales concreto/acero por default del proyecto (primer match)
    materials = model.get("materials", {})
    concrete_name = ""
    steel_name    = ""
    for name, m in materials.items():
        kind = str(m.get("kind", "")).lower()
        if not concrete_name and ("concrete" in kind or "fpc_mpa" in m):
            concrete_name = name
        if not steel_name and ("steel" in kind or "fy_mpa" in m):
            steel_name = name
    if not concrete_name and materials:
        concrete_name = next(iter(materials.keys()))
    if not steel_name:
        steel_name = concrete_name

    fy_default = 420.0
    for m in materials.values():
        if "fy_mpa" in m:
            fy_default = float(m["fy_mpa"])
            break

    if "wall_design"      not in model: model["wall_design"]      = {}
    if "wall_design_meta" not in model: model["wall_design_meta"] = {}
    wall_store = _wall_store(model)

    designed, built, failed = [], [], []

    def _drop_stale(lbl: str) -> None:
        """Elimina diseño obsoleto del canonical cuando el nuevo cálculo falla.
        Sin esto, si el motor endurece criterios, muros que antes cerraban con
        refuerzo excesivo quedan en el canonical eternamente (bug histórico)."""
        model["wall_design"].pop(lbl, None)
        model["wall_design_meta"].pop(lbl, None)
        wall_store.pop(lbl, None)

    for label, (key, g) in wall_map.items():
        pier, story = key.split("|", 1)
        rows = _demands_for_pier(pier_demands, pier, story)
        if not rows:
            failed.append({"label": label, "reason": "sin demandas"})
            _drop_stale(label)
            continue

        lw = float(g.get("lw", 0.0))
        tw = float(g.get("tw", 0.0))
        hw = float(g.get("hw", 0.0))
        fc = float(g.get("fc_mpa", 28.0))
        if lw <= 0 or tw <= 0 or hw <= 0:
            failed.append({"label": label, "reason": f"geometría inválida"})
            _drop_stale(label)
            continue

        axis    = _wall_axis(g)
        demands = [_to_wall_demand_combo(r, axis) for r in rows]

        # ── 1. Auto-diseño ────────────────────────────────────────────────────
        try:
            result = compute_wall_design(
                lw_m=lw, tw_m=tw, hw_m=hw,
                fc_mpa=fc, fy_mpa=fy_default, fyt_mpa=body.fyt_mpa,
                ductility=ductility, demands=demands, mode="auto",
                cover_mm=body.cover_mm, delta_u_hw=body.delta_u_hw,
            )
        except WallNotDesignableError as exc:
            failed.append({"label": label, "reason": f"no diseñable — {exc}"})
            _drop_stale(label)
            continue
        except Exception as exc:
            failed.append({"label": label, "reason": f"design error: {exc}"})
            _drop_stale(label)
            continue

        model["wall_design"][label] = result
        model["wall_design_meta"][label] = {
            "pier": pier, "story": story, "axis": axis,
            "ductility": ductility, "fc_mpa": fc, "fy_mpa": fy_default,
            "fyt_mpa": body.fyt_mpa, "cover_mm": body.cover_mm,
            "geometry": {"lw_m": lw, "tw_m": tw, "hw_m": hw},
            "demands": [
                {"label": d.label, "Pu_kN": d.Pu_kN, "Vu_kN": d.Vu_kN,
                 "Mu_kNm": d.Mu_kNm, "is_seismic": d.is_seismic}
                for d in demands
            ],
        }
        designed.append(label)

        # ── 2. Construir MVLEM_3D con refuerzo diseñado ───────────────────────
        try:
            lb, web_zone, rb = _reinforcement_to_zones(result, tw, concrete_name, steel_name)

            # N° macrofibras: por ancho_max o fijo
            if body.n_fibers > 0:
                n_fibers = body.n_fibers
            else:
                n_fibers = max(2, int(round(lw / max(body.width_max_m, 0.05))))

            # Nodos de la shell
            joints = model.get("shells", {}).get(label, {}).get("joints", ["", "", "", ""])
            wall_model = ESFIMVLEM3DModel.from_physical_wall(
                node_i=joints[0] if len(joints) > 0 else "",
                node_j=joints[1] if len(joints) > 1 else "",
                node_k=joints[2] if len(joints) > 2 else "",
                node_l=joints[3] if len(joints) > 3 else "",
                wall_length_m=lw, wall_thickness_m=tw,
                left_boundary=lb, web=web_zone, right_boundary=rb,
                n_fibers=n_fibers,
                c_rot=body.c_rot, thick_mod=body.thick_mod, poisson=body.poisson,
                source_pier=pier, source_story=story,
            )
            if form != WallFormulation.E_SFI_MVLEM_3D:
                wall_model.formulation = form

            wall_store[label] = wall_model.to_dict()
            built.append(label)
        except Exception as exc:
            failed.append({"label": label, "reason": f"MVLEM build: {exc}", "designed_ok": True})

    _save_canonical(proj, model)

    return {
        "designed_count": len(designed),
        "built_count":    len(built),
        "failed_count":   len(failed),
        "total_walls":    len(wall_map),
        "designed":       designed[:200],
        "built":          built[:200],
        "failed":         failed[:100],
        "ductility":      ductility,
        "formulation":    form.value,
        "n_fibers_mode":  "fixed" if body.n_fibers > 0 else f"width_max={body.width_max_m}m",
    }



