"""
Router — Módulo 5: Análisis de Muros RC 3D.

Gestiona proyectos de análisis no lineal de muros RC independientes del
Módulo 1. Cada proyecto almacena su propio documento JSON con materiales,
muros (macrofibras MVLEM_3D / E-SFI-MVLEM-3D) y configuración de análisis.

Prefix: /api/v1/wall-projects
Auth:   JWT required.

Endpoints:
  GET  /                           — listar proyectos del usuario
  POST /                           — crear proyecto
  GET  /presets/materials          — catálogo de materiales predefinidos
  GET  /presets/materials/all      — todos los presets ConcreteCM
  GET  /{id}                       — obtener proyecto
  DELETE /{id}                     — eliminar proyecto
  GET  /{id}/document              — obtener documento completo
  PUT  /{id}/document              — guardar documento (actualiza hash + estado)
  GET  /{id}/jobs                  — listar jobs de análisis
  POST /{id}/export-script         — exportar script standalone OpenSeesPy
"""
from __future__ import annotations

import hashlib
import json
import os
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.models import User, WallProject, WallProjectStatus, WallJob, WallJobStatus, WallJobType
from app.engine.building.walls import (
    default_material_catalog,
    all_concretecm_presets_list,
    colombian_mvlem_basic_set,
    reinforcing_bar_preset,
    wwm_reinforcement_preset,
)

router = APIRouter(prefix="/api/v1/wall-projects", tags=["wall-projects"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]

SCHEMA_VERSION = "wrc-1.0"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _work_dir(project_id: str) -> Path:
    base = Path(getattr(settings, "upload_dir", "/tmp/performancelabs"))
    d = base / "wall_projects" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _doc_path(project_id: str) -> Path:
    return _work_dir(project_id) / "wall_project.json"


def _stable_hash(data: Any) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def _get_project(project_id: str, user: User, db: Session) -> WallProject:
    p = db.query(WallProject).filter(
        WallProject.id == project_id,
        WallProject.owner_id == user.id,
    ).first()
    if not p:
        raise HTTPException(status_code=404, detail="Proyecto de muros no encontrado")
    return p


def _load_document(project: WallProject) -> dict:
    if not project.document_path or not os.path.exists(project.document_path):
        raise HTTPException(status_code=404, detail="Documento del proyecto no disponible")
    with open(project.document_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _project_out(p: WallProject) -> dict:
    return {
        "id":           p.id,
        "name":         p.name,
        "description":  p.description,
        "status":       p.status.value,
        "document_hash": p.document_hash,
        "has_document": p.document_path is not None and os.path.exists(p.document_path or ""),
        "created_at":   p.created_at.isoformat(),
        "updated_at":   p.updated_at.isoformat(),
    }


def _new_document(name: str = "") -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "name": name,
        "detailing": "DES",
        "units": {"length": "m", "force": "kN", "mass": "t"},
        "materials": default_material_catalog(),
        "walls": [],
        "analysis": {
            "gravity_steps": 10,
            "modal_modes": 6,
            "pushover_directions": ["X"],
            "target_drift_pct": 2.0,
            "displacement_increment_m": 0.001,
        },
    }


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class CreateProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    initialize_document: bool = True


class MvlemBasicSetIn(BaseModel):
    fc_mpa:    float = 28.0
    fy_mpa:    float = 420.0
    detailing: str   = "DES"
    id_prefix: str   = "mvlem_basic"


class LaunchAnalysisIn(BaseModel):
    job_type:   str = "pushover"           # "gravity" | "modal" | "pushover"
    direction:  str = "X"                  # "X"|"-X"|"Y"|"-Y" — only for pushover


# ── Endpoints — presets (BEFORE /{id} to avoid route conflict) ───────────────

@router.get("/presets/materials")
def get_default_materials():
    """Default material catalog for a new wall project (ConcreteCM 28 MPa + bars + WWM)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "materials": default_material_catalog(),
    }


@router.get("/presets/materials/all")
def get_all_concretecm_presets():
    """All 8 ConcreteCM presets: 21/28/35/42 MPa × confined/unconfined."""
    presets = all_concretecm_presets_list()
    bars    = [reinforcing_bar_preset(420), reinforcing_bar_preset(490)]
    wwm     = wwm_reinforcement_preset()
    return {"concretecm": presets, "bars": bars, "wwm": wwm}


@router.post("/presets/mvlem-basic-set")
def generate_mvlem_basic_set(body: MvlemBasicSetIn):
    """Generate Concrete02 + HystereticSM set for MVLEM_3D (opseestools port)."""
    try:
        materials = colombian_mvlem_basic_set(
            fc_mpa=body.fc_mpa,
            fy_mpa=body.fy_mpa,
            detailing=body.detailing,  # type: ignore[arg-type]
            id_prefix=body.id_prefix,
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"materials": materials}


# ── Endpoints — project CRUD ──────────────────────────────────────────────────

@router.get("")
def list_projects(user: CurrentUser, db: DB):
    projects = db.query(WallProject).filter(
        WallProject.owner_id == user.id
    ).order_by(WallProject.created_at.desc()).all()
    return [_project_out(p) for p in projects]


@router.post("", status_code=201)
def create_project(body: CreateProjectIn, user: CurrentUser, db: DB):
    p = WallProject(
        owner_id=user.id,
        name=body.name,
        description=body.description,
        status=WallProjectStatus.empty,
    )
    db.add(p)
    db.flush()  # get p.id

    if body.initialize_document:
        doc  = _new_document(body.name)
        path = _doc_path(p.id)
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        p.document_path = str(path)
        p.document_hash = _stable_hash(doc)
        p.status        = WallProjectStatus.ready

    db.commit()
    db.refresh(p)
    return _project_out(p)


@router.get("/{project_id}")
def get_project(project_id: str, user: CurrentUser, db: DB):
    p = _get_project(project_id, user, db)
    out = _project_out(p)

    # Include latest job summary if any
    latest = (
        db.query(WallJob)
        .filter(WallJob.project_id == project_id)
        .order_by(WallJob.created_at.desc())
        .first()
    )
    if latest:
        out["latest_job"] = {
            "id":        latest.id,
            "job_type":  latest.job_type.value,
            "status":    latest.status.value,
            "created_at": latest.created_at.isoformat(),
        }
    return out


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, user: CurrentUser, db: DB):
    p = _get_project(project_id, user, db)
    # Remove work directory
    work = _work_dir(project_id)
    import shutil
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    db.delete(p)
    db.commit()


# ── Document endpoints ────────────────────────────────────────────────────────

@router.get("/{project_id}/document")
def get_document(project_id: str, user: CurrentUser, db: DB):
    p   = _get_project(project_id, user, db)
    doc = _load_document(p)
    return doc


@router.put("/{project_id}/document")
def save_document(project_id: str, body: dict, user: CurrentUser, db: DB):
    """
    Save/replace the full project document.

    Validates schema_version, computes SHA256 hash, and updates project status.
    If the hash changed from the last analysis, status returns to 'ready'.
    """
    p = _get_project(project_id, user, db)

    schema = body.get("schema_version", "")
    if not schema.startswith("wrc-"):
        raise HTTPException(
            status_code=422,
            detail=f"schema_version inválido: '{schema}'. Debe empezar con 'wrc-'."
        )

    path = _doc_path(project_id)
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")

    new_hash     = _stable_hash(body)
    hash_changed = new_hash != p.document_hash

    p.document_path = str(path)
    p.document_hash = new_hash

    if p.status == WallProjectStatus.done and hash_changed:
        p.status = WallProjectStatus.ready
    elif p.status == WallProjectStatus.empty:
        p.status = WallProjectStatus.ready

    db.commit()
    db.refresh(p)
    return {
        "ok":           True,
        "document_hash": new_hash,
        "hash_changed": hash_changed,
        "status":        p.status.value,
    }


# ── Jobs endpoint (read-only listing) ────────────────────────────────────────

@router.get("/{project_id}/jobs")
def list_jobs(project_id: str, user: CurrentUser, db: DB):
    _get_project(project_id, user, db)
    jobs = (
        db.query(WallJob)
        .filter(WallJob.project_id == project_id)
        .order_by(WallJob.created_at.desc())
        .all()
    )
    return [
        {
            "id":            j.id,
            "job_type":      j.job_type.value,
            "status":        j.status.value,
            "push_direction": j.push_direction,
            "result_summary": j.result_summary,
            "error_message":  j.error_message,
            "created_at":    j.created_at.isoformat(),
            "finished_at":   j.finished_at.isoformat() if j.finished_at else None,
        }
        for j in jobs
    ]


# ── Script export ─────────────────────────────────────────────────────────────

@router.post("/{project_id}/export-script", response_class=PlainTextResponse)
def export_standalone_script(project_id: str, user: CurrentUser, db: DB):
    """
    Generate a standalone OpenSeesPy script from the project document.

    The script sets up all materials and wall elements defined in the document
    and can be run independently with: python wall_analysis.py

    Full analysis phases (gravity + modal + pushover) will be added in Phase 2.
    """
    p   = _get_project(project_id, user, db)
    doc = _load_document(p)

    walls     = doc.get("walls", [])
    materials = doc.get("materials", {})
    detailing = doc.get("detailing", "DES")
    units     = doc.get("units", {"length": "m", "force": "kN"})

    lines: list[str] = []

    lines.append('#!/usr/bin/env python3')
    lines.append(f'"""Standalone OpenSeesPy script — {p.name}')
    lines.append(f'Generated by PerformanceLabs wall module (schema {SCHEMA_VERSION}).')
    lines.append(f'Project ID : {project_id}')
    lines.append(f'Document hash: {p.document_hash}')
    lines.append(f'Generated : {datetime.now(timezone.utc).isoformat()}')
    lines.append(f'Units     : length={units.get("length","m")}, force={units.get("force","kN")}')
    lines.append('"""')
    lines.append('import openseespy.opensees as ops')
    lines.append('')
    lines.append('ops.wipe()')
    lines.append('ops.model("basic", "-ndm", 3, "-ndf", 6)')
    lines.append('')

    # ── Materials ─────────────────────────────────────────────────────────────
    lines.append('# ── Materials ──────────────────────────────────────────────')
    mat_tag: dict[str, int] = {}
    tag = 1
    for mid, mat in materials.items():
        kind = mat.get("kind", "")
        name = mat.get("name", mid)
        lines.append(f'# {name} ({kind})')
        if kind == "ConcreteCM":
            lines.append(
                f'ops.uniaxialMaterial("ConcreteCM", {tag}, '
                f'{mat.get("fpcc",0)}, {mat.get("epcc",0)}, {mat.get("Ec",0)}, '
                f'{mat.get("rc",0)}, {mat.get("xcrn",1.04)}, '
                f'{mat.get("ft",0)}, {mat.get("et",0)}, {mat.get("rt",1.2)}, '
                f'{mat.get("xcrp",100)}, {mat.get("gapClose",0)})'
            )
        elif kind == "Concrete02":
            lines.append(
                f'ops.uniaxialMaterial("Concrete02", {tag}, '
                f'{mat.get("fpc",0)}, {mat.get("epsc0",0)}, '
                f'{mat.get("fpcu",0)}, {mat.get("epsU",0)}, '
                f'{mat.get("lamb",0.1)}, {mat.get("ft",0)}, {mat.get("Ets",0)})'
            )
        elif kind in ("Hysteretic", "HystereticSM"):
            pos = mat.get("positive", [])
            neg = mat.get("negative", [])
            p1 = ", ".join(f"{v}" for pt in pos for v in pt)
            n1 = ", ".join(f"{v}" for pt in neg for v in pt)
            lines.append(
                f'ops.uniaxialMaterial("{kind}", {tag}, {p1}, {n1}, '
                f'{mat.get("pinchX",1)}, {mat.get("pinchY",1)}, '
                f'{mat.get("damage1",0)}, {mat.get("damage2",0)}, {mat.get("beta",0)})'
            )
        elif kind == "Elastic":
            lines.append(f'ops.uniaxialMaterial("Elastic", {tag}, {mat.get("stiffness",1e6)})')
        else:
            lines.append(f'# WARNING: unknown material kind "{kind}" — skipped')
            tag += 1
            continue
        mat_tag[mid] = tag
        tag += 1

    lines.append('')

    # ── Walls ─────────────────────────────────────────────────────────────────
    lines.append('# ── Wall elements ──────────────────────────────────────────')
    node_tag = 1
    ele_tag  = 1
    for wall in walls:
        wid   = wall.get("id", f"w{ele_tag}")
        wname = wall.get("name", wid)
        form  = wall.get("formulation", "E_SFI_MVLEM_3D")
        lw    = wall.get("length_m",    4.0)
        tw    = wall.get("thickness_m", 0.2)
        hw    = wall.get("height_m",    3.0)
        c_rot = wall.get("c_rot",       0.4)
        tkm   = wall.get("thick_mod",   0.63)
        nu    = wall.get("poisson",     0.25)
        mf    = wall.get("macrofibers", [])
        n_fib = len(mf) if mf else wall.get("n_fibers", 8)

        lines.append(f'')
        lines.append(f'# Wall: {wname}  ({lw:.2f} m × {tw:.2f} m × {hw:.2f} m)')

        # 4 corner nodes
        n0, n1, n2, n3 = node_tag, node_tag+1, node_tag+2, node_tag+3
        node_tag += 4
        lines.append(f'ops.node({n0},  0.0,   0.0,  0.0)')
        lines.append(f'ops.node({n1},  {lw:.4f}, 0.0,  0.0)')
        lines.append(f'ops.node({n2},  {lw:.4f}, 0.0,  {hw:.4f})')
        lines.append(f'ops.node({n3},  0.0,   0.0,  {hw:.4f})')
        lines.append(f'ops.fix({n0}, 1,1,1,1,1,1)')
        lines.append(f'ops.fix({n1}, 1,1,1,1,1,1)')

        if not mf:
            # Uniform macrofiber strip
            width_each = lw / n_fib
            thick_tags_v = []
            thick_tags_s = []
            thick_vals   = []
            width_vals   = []
            rho_v_vals   = []

            for i in range(n_fib):
                thick_vals.append(tw)
                width_vals.append(width_each)
                rho_v_vals.append(0.01)
                # Placeholder tags — user should wire real material IDs
                thick_tags_v.append(tag)
                tag += 1
                thick_tags_s.append(tag)
                tag += 1

            thick_str = " ".join(f"{v:.4f}" for v in thick_vals)
            width_str = " ".join(f"{v:.4f}" for v in width_vals)
            rho_str   = " ".join(f"{v:.4f}" for v in rho_v_vals)
            mv_str    = " ".join(str(t) for t in thick_tags_v)
            ms_str    = " ".join(str(t) for t in thick_tags_s)

            lines.append(f'# WARNING: no macrofibers defined — using uniform strip (set material IDs manually)')
            lines.append(
                f'ops.element("{form}", {ele_tag}, {n0},{n1},{n2},{n3}, {n_fib}, '
                f'"-thick", {thick_str}, "-width", {width_str}, "-rho", {rho_str}, '
                f'"-matConcrete", {mv_str}, "-matSteel", {ms_str}, "-matShear", 1, '
                f'"-CoR", {c_rot}, "-ThickMod", {tkm}, "-Poisson", {nu}, "-Density", 0.0)'
            )
        else:
            thick_vals = [f.get("thickness_m", tw) for f in mf]
            width_vals = [f.get("width_m", lw / n_fib) for f in mf]
            rho_v      = [f.get("rho_vertical", 0.01) for f in mf]
            mat_conc   = [mat_tag.get(f.get("concrete_material_id", ""), 1) for f in mf]
            mat_sv     = [mat_tag.get(f.get("steel_v_material_id", ""), 2) for f in mf]
            mat_sh     = [mat_tag.get(f.get("steel_h_material_id", ""), 2) for f in mf]

            thick_str = " ".join(f"{v:.4f}" for v in thick_vals)
            width_str = " ".join(f"{v:.4f}" for v in width_vals)
            rho_str   = " ".join(f"{v:.4f}" for v in rho_v)
            mc_str    = " ".join(str(t) for t in mat_conc)
            msv_str   = " ".join(str(t) for t in mat_sv)
            msh_str   = " ".join(str(t) for t in mat_sh)

            if form == "E_SFI_MVLEM_3D":
                lines.append(
                    f'ops.element("E_SFI_MVLEM_3D", {ele_tag}, {n0},{n1},{n2},{n3}, {n_fib}, '
                    f'"-thick", {thick_str}, "-width", {width_str}, "-rho", {rho_str}, '
                    f'"-matConcrete", {mc_str}, "-matSteel", {msv_str}, '
                    f'"-CoR", {c_rot}, "-ThickMod", {tkm}, "-Poisson", {nu}, "-Density", 0.0)'
                )
            else:
                lines.append(
                    f'ops.element("MVLEM_3D", {ele_tag}, {n0},{n1},{n2},{n3}, {n_fib}, '
                    f'"-thick", {thick_str}, "-width", {width_str}, "-rho", {rho_str}, '
                    f'"-matConcrete", {mc_str}, "-matSteel", {msv_str}, "-matShear", {mat_sh[0]}, '
                    f'"-CoR", {c_rot}, "-ThickMod", {tkm}, "-Poisson", {nu}, "-Density", 0.0)'
                )

        ele_tag += 1

    lines.append('')
    lines.append('# ── TODO Phase 2: gravity + modal + pushover analysis ─────')
    lines.append('print("Model built successfully.")')
    lines.append('')

    return PlainTextResponse(
        "\n".join(lines),
        headers={"Content-Disposition": f'attachment; filename="wall_analysis_{project_id[:8]}.py"'},
    )


# ── Analysis launch ───────────────────────────────────────────────────────────

@router.post("/{project_id}/analyze", status_code=202)
def launch_analysis(project_id: str, body: LaunchAnalysisIn, user: CurrentUser, db: DB):
    """
    Launch a wall analysis job (Celery).

    job_type: "gravity" | "modal" | "pushover"
    direction: only for pushover — "X" | "-X" | "Y" | "-Y"
    """
    p = _get_project(project_id, user, db)
    if not p.document_path or not os.path.exists(p.document_path):
        raise HTTPException(status_code=400, detail="Guarda el documento antes de analizar")

    job_type_map = {
        "gravity":  WallJobType.gravity,
        "modal":    WallJobType.modal,
        "pushover": WallJobType.pushover,
    }
    jt = job_type_map.get(body.job_type)
    if not jt:
        raise HTTPException(status_code=422, detail=f"job_type inválido: '{body.job_type}'")

    direction = body.direction.upper()
    if jt == WallJobType.pushover and direction not in ("X", "-X", "Y", "-Y"):
        raise HTTPException(status_code=422, detail="direction debe ser X, -X, Y o -Y")

    job = WallJob(
        project_id     = project_id,
        owner_id       = user.id,
        job_type       = jt,
        push_direction = direction if jt == WallJobType.pushover else None,
        status         = WallJobStatus.pending,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    from app.tasks.wall_analysis_task import run_gravity, run_modal, run_pushover

    if jt == WallJobType.gravity:
        task = run_gravity.delay(project_id, job.id)
    elif jt == WallJobType.modal:
        task = run_modal.delay(project_id, job.id)
    else:
        task = run_pushover.delay(project_id, job.id, direction)

    job.celery_task_id = task.id
    db.commit()

    return {
        "job_id":     job.id,
        "job_type":   jt.value,
        "status":     "pending",
        "direction":  direction if jt == WallJobType.pushover else None,
        "celery_id":  task.id,
    }


@router.get("/{project_id}/jobs/{job_id}/status")
def job_status(project_id: str, job_id: str, user: CurrentUser, db: DB):
    _get_project(project_id, user, db)
    job = db.query(WallJob).filter(
        WallJob.id == job_id,
        WallJob.project_id == project_id,
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job no encontrado")
    return {
        "id":             job.id,
        "job_type":       job.job_type.value,
        "status":         job.status.value,
        "push_direction": job.push_direction,
        "result_summary": job.result_summary,
        "error_message":  job.error_message,
        "created_at":     job.created_at.isoformat(),
        "finished_at":    job.finished_at.isoformat() if job.finished_at else None,
    }


@router.get("/{project_id}/jobs/{job_id}/result")
def job_result(project_id: str, job_id: str, user: CurrentUser, db: DB):
    """Return the full result JSON for a completed job."""
    _get_project(project_id, user, db)
    job = db.query(WallJob).filter(
        WallJob.id == job_id,
        WallJob.project_id == project_id,
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job no encontrado")
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Resultados aún no disponibles")
    import json as _json
    with open(job.result_path, "r", encoding="utf-8") as f:
        return _json.load(f)
