"""
Router — Módulo 1 v3: API de edición del modelo estructural canónico.

Permite al frontend leer y modificar secciones, materiales y asignaciones de sección
en el structural_model.json sin necesidad de reimportar el modelo ETABS.

Prefix: /api/v1/projects  (compartido con structural_projects.py)
Auth:   JWT requerido en todos los endpoints.
"""
import json
import math
import os
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import StructuralProject, User

router = APIRouter(prefix="/api/v1/projects", tags=["structural-editor"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB = Annotated[Session, Depends(get_db)]


# ── Helpers internos ──────────────────────────────────────────────────────────

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
        raise HTTPException(
            status_code=404,
            detail="Modelo canónico no disponible. Importa y valida el modelo primero.",
        )
    with open(project.canonical_model_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_canonical(project: StructuralProject, model: dict) -> None:
    with open(project.canonical_model_path, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2, ensure_ascii=False)


def _auto_section_props(
    b_m: float, h_m: float,
    A_m2: float, I33_m4: float, I22_m4: float, J_m4: float
) -> tuple[float, float, float, float]:
    """Calcula propiedades geométricas desde b y h cuando no se proveen."""
    if A_m2 == 0 and b_m > 0 and h_m > 0:
        A_m2 = round(b_m * h_m, 6)
    if I33_m4 == 0 and b_m > 0 and h_m > 0:
        I33_m4 = round(b_m * h_m ** 3 / 12.0, 10)
    if I22_m4 == 0 and b_m > 0 and h_m > 0:
        I22_m4 = round(h_m * b_m ** 3 / 12.0, 10)
    if J_m4 == 0 and b_m > 0 and h_m > 0:
        # Aproximación de Saint-Venant para sección rectangular
        a = max(b_m, h_m) / 2.0
        b = min(b_m, h_m) / 2.0
        if a > 0:
            ratio = b / a
            J_m4 = round(
                a * b ** 3 * (16.0 / 3.0 - 3.36 * ratio * (1.0 - ratio ** 4 / 12.0)),
                10,
            )
    return A_m2, I33_m4, I22_m4, J_m4


def _auto_material_props(
    mat_type: str, fpc: float, E: float, G: float, nu: float
) -> tuple[float, float]:
    """Calcula E y G cuando no se proveen."""
    if mat_type == "concrete" and fpc > 0 and E == 0:
        E = round(4700.0 * math.sqrt(fpc), 1)   # ACI 318: Ec = 4700√f'c (MPa)
    elif mat_type == "steel" and E == 0:
        E = 200_000.0
    if E > 0 and G == 0:
        G = round(E / (2.0 * (1.0 + nu)), 1)
    return E, G


# ── Schemas Pydantic ──────────────────────────────────────────────────────────

class SectionCreate(BaseModel):
    name: str
    material: str
    shape: str = "Rectangular"
    h_m: float          # altura / profundidad (m)
    b_m: float          # ancho (m)
    A_m2: float = 0.0
    I33_m4: float = 0.0
    I22_m4: float = 0.0
    J_m4: float = 0.0


class SectionUpdate(BaseModel):
    material: str
    shape: str = "Rectangular"
    h_m: float
    b_m: float
    A_m2: float = 0.0
    I33_m4: float = 0.0
    I22_m4: float = 0.0
    J_m4: float = 0.0


class MaterialCreate(BaseModel):
    name: str
    type: str = "concrete"   # concrete | steel
    fpc_mpa: float = 0.0     # f'c para concreto (MPa)
    fy_mpa: float = 0.0      # fy para acero (MPa)
    E_mpa: float = 0.0
    G_mpa: float = 0.0
    nu: float = 0.2


class MaterialUpdate(BaseModel):
    type: str = "concrete"
    fpc_mpa: float = 0.0
    fy_mpa: float = 0.0
    E_mpa: float = 0.0
    G_mpa: float = 0.0
    nu: float = 0.2


class AssignSectionBody(BaseModel):
    frame_ids: list[str]
    section_name: str


class RestoreAssignmentsBody(BaseModel):
    assignments: dict[str, str]   # frameId → sectionName (vacío = sin sección)


# ── Lectura del modelo ────────────────────────────────────────────────────────

@router.get("/{project_id}/model-data")
async def get_model_data(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna el modelo canónico completo para el editor interactivo.
    No incluye analysis_results (puede ser muy pesado).
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    return {
        "schema_version": model.get("schema_version", "1.0"),
        "metadata": model.get("metadata", {}),
        "stories": model.get("stories", {}),
        "joints": model.get("joints", {}),
        "restraints": model.get("restraints", {}),
        "sections": model.get("sections", {}),
        "materials": model.get("materials", {}),
        "frames": model.get("frames", {}),
        "shells": model.get("shells", {}),
        "masses": model.get("masses", {}),
    }


# ── Model Health Check ────────────────────────────────────────────────────────

@router.get("/{project_id}/model-check")
async def get_model_check(project_id: str, user: CurrentUser, db: DB):
    """
    Validación rápida del modelo canónico actual.
    Detecta: frames sin sección, secciones sin material, longitud cero, nodos aislados.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    joints = model.get("joints", {})
    frames = model.get("frames", {})
    sections = model.get("sections", {})
    materials = model.get("materials", {})
    restraints = model.get("restraints", {})
    shells = model.get("shells", {})
    masses = model.get("masses", {})

    warnings: list[dict] = []
    errors: list[dict] = []

    # ── Frames sin sección ───────────────────────────────────────────────────
    no_section = [fid for fid, fd in frames.items() if not fd.get("section")]
    if no_section:
        errors.append({
            "code": "FRAME_NO_SECTION",
            "severity": "error",
            "message": f"{len(no_section)} elemento(s) sin sección asignada.",
            "element_ids": no_section[:50],
            "count": len(no_section),
        })

    # ── Secciones referenciadas pero no definidas ────────────────────────────
    used_secs = {fd.get("section", "") for fd in frames.values() if fd.get("section")}
    undefined_secs = used_secs - set(sections.keys())
    if undefined_secs:
        errors.append({
            "code": "SECTION_UNDEFINED",
            "severity": "error",
            "message": f"{len(undefined_secs)} sección(es) referenciadas pero no definidas en el modelo.",
            "items": sorted(undefined_secs)[:15],
            "count": len(undefined_secs),
        })

    # ── Secciones sin material válido ────────────────────────────────────────
    no_mat_secs = [
        sname for sname, sd in sections.items()
        if not sd.get("material") or sd["material"] not in materials
    ]
    if no_mat_secs:
        errors.append({
            "code": "SECTION_NO_MATERIAL",
            "severity": "error",
            "message": f"{len(no_mat_secs)} sección(es) sin material válido asignado.",
            "items": no_mat_secs[:15],
            "count": len(no_mat_secs),
        })

    # ── Elementos de longitud cero ────────────────────────────────────────────
    zero_len: list[str] = []
    for fid, fd in frames.items():
        ji = joints.get(str(fd.get("joint_i", "")), {})
        jj = joints.get(str(fd.get("joint_j", "")), {})
        dx = float(jj.get("x", 0)) - float(ji.get("x", 0))
        dy = float(jj.get("y", 0)) - float(ji.get("y", 0))
        dz = float(jj.get("z", 0)) - float(ji.get("z", 0))
        L = math.sqrt(dx ** 2 + dy ** 2 + dz ** 2)
        if L < 0.001:
            zero_len.append(fid)
    if zero_len:
        errors.append({
            "code": "ZERO_LENGTH",
            "severity": "error",
            "message": f"{len(zero_len)} elemento(s) con longitud ≤ 1 mm.",
            "element_ids": zero_len[:20],
            "count": len(zero_len),
        })

    # ── Sin restricciones de base ─────────────────────────────────────────────
    if not restraints:
        errors.append({
            "code": "NO_RESTRAINTS",
            "severity": "error",
            "message": "El modelo no tiene apoyos definidos (joints restringidos).",
            "count": 0,
        })

    # ── Nodos aislados ────────────────────────────────────────────────────────
    used_joints: set[str] = set()
    for fd in frames.values():
        used_joints.add(str(fd.get("joint_i", "")))
        used_joints.add(str(fd.get("joint_j", "")))
    used_joints |= set(restraints.keys())
    isolated = [jid for jid in joints if jid not in used_joints]
    if len(isolated) > 0:
        warnings.append({
            "code": "ISOLATED_NODES",
            "severity": "warning",
            "message": f"{len(isolated)} nodo(s) aislado(s) sin conectividad a frames.",
            "count": len(isolated),
        })

    # ── Sin masas ────────────────────────────────────────────────────────────
    if not masses:
        warnings.append({
            "code": "NO_MASSES",
            "severity": "warning",
            "message": "No hay información de masas por diafragma. El análisis modal puede fallar.",
            "count": 0,
        })

    # ── Estadísticas por tipo ─────────────────────────────────────────────────
    n_cols  = sum(1 for fd in frames.values() if fd.get("element_type") == "column")
    n_beams = sum(1 for fd in frames.values() if fd.get("element_type") == "beam")
    n_walls = sum(1 for sd in shells.values() if sd.get("element_type") == "wall")
    n_slabs = sum(1 for sd in shells.values() if sd.get("element_type") == "slab")

    return {
        "geometry_ok": len(zero_len) == 0,
        "connectivity_ok": len(isolated) == 0,
        "materials_ok": len(no_mat_secs) == 0,
        "sections_ok": len(no_section) == 0 and len(undefined_secs) == 0,
        "loads_ok": bool(masses),
        "n_frames_no_section": len(no_section),
        "n_sections_no_material": len(no_mat_secs),
        "n_undefined_sections": len(undefined_secs),
        "n_zero_length": len(zero_len),
        "n_isolated_nodes": len(isolated),
        "n_columns": n_cols,
        "n_beams": n_beams,
        "n_walls": n_walls,
        "n_slabs": n_slabs,
        "warnings": warnings,
        "errors": errors,
        "ready_for_analysis": not errors,
        "n_errors": len(errors),
        "n_warnings": len(warnings),
    }


# ── Secciones CRUD ────────────────────────────────────────────────────────────

@router.post("/{project_id}/model/sections")
async def create_section(project_id: str, body: SectionCreate, user: CurrentUser, db: DB):
    """Crea una nueva sección en el modelo canónico."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if body.name in model.get("sections", {}):
        raise HTTPException(status_code=409, detail=f"Ya existe una sección con el nombre '{body.name}'")
    if body.material not in model.get("materials", {}):
        raise HTTPException(status_code=422, detail=f"Material '{body.material}' no existe en el modelo")

    A, I33, I22, J = _auto_section_props(body.b_m, body.h_m, body.A_m2, body.I33_m4, body.I22_m4, body.J_m4)
    mat = model["materials"][body.material]
    E = mat.get("E_mpa", 0.0)
    G = mat.get("G_mpa", 0.0)

    sec = {
        "material": body.material,
        "shape": body.shape,
        "h_m": round(body.h_m, 4),
        "b_m": round(body.b_m, 4),
        "A_m2": round(A, 6),
        "I33_m4": round(I33, 10),
        "I22_m4": round(I22, 10),
        "J_m4": round(J, 10),
        "E_mpa": E,
        "G_mpa": G,
    }
    model.setdefault("sections", {})[body.name] = sec
    model["metadata"]["n_sections"] = len(model["sections"])
    _save_canonical(project, model)
    return {"ok": True, "name": body.name, "data": sec}


@router.put("/{project_id}/model/sections/{name}")
async def update_section(
    project_id: str, name: str, body: SectionUpdate, user: CurrentUser, db: DB
):
    """Actualiza las propiedades de una sección existente."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if name not in model.get("sections", {}):
        raise HTTPException(status_code=404, detail=f"Sección '{name}' no encontrada")
    if body.material not in model.get("materials", {}):
        raise HTTPException(status_code=422, detail=f"Material '{body.material}' no existe en el modelo")

    A, I33, I22, J = _auto_section_props(body.b_m, body.h_m, body.A_m2, body.I33_m4, body.I22_m4, body.J_m4)
    mat = model["materials"][body.material]
    E = mat.get("E_mpa", 0.0)
    G = mat.get("G_mpa", 0.0)

    sec = {
        "material": body.material,
        "shape": body.shape,
        "h_m": round(body.h_m, 4),
        "b_m": round(body.b_m, 4),
        "A_m2": round(A, 6),
        "I33_m4": round(I33, 10),
        "I22_m4": round(I22, 10),
        "J_m4": round(J, 10),
        "E_mpa": E,
        "G_mpa": G,
    }
    model["sections"][name] = sec
    _save_canonical(project, model)
    return {"ok": True, "name": name, "data": sec}


@router.delete("/{project_id}/model/sections/{name}")
async def delete_section(project_id: str, name: str, user: CurrentUser, db: DB):
    """
    Elimina una sección del modelo.
    Los frames que la referenciaban quedan con section="" (sin sección).
    No se puede eliminar si está en uso — el cliente debe desasignar primero,
    o acepta el comportamiento de limpiar frames automáticamente.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if name not in model.get("sections", {}):
        raise HTTPException(status_code=404, detail=f"Sección '{name}' no encontrada")

    del model["sections"][name]
    model["metadata"]["n_sections"] = len(model["sections"])

    # Limpiar referencias de frames
    affected = 0
    for fd in model.get("frames", {}).values():
        if fd.get("section") == name:
            fd["section"] = ""
            affected += 1

    _save_canonical(project, model)
    return {"ok": True, "deleted": name, "frames_affected": affected}


# ── Materiales CRUD ───────────────────────────────────────────────────────────

@router.post("/{project_id}/model/materials")
async def create_material(project_id: str, body: MaterialCreate, user: CurrentUser, db: DB):
    """Crea un nuevo material en el modelo canónico."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if body.name in model.get("materials", {}):
        raise HTTPException(status_code=409, detail=f"Ya existe un material con el nombre '{body.name}'")

    E, G = _auto_material_props(body.type, body.fpc_mpa, body.E_mpa, body.G_mpa, body.nu)
    mat: dict = {
        "type": body.type,
        "fpc_mpa": round(body.fpc_mpa, 2),
        "E_mpa": round(E, 1),
        "G_mpa": round(G, 1),
    }
    if body.fy_mpa > 0:
        mat["fy_mpa"] = round(body.fy_mpa, 2)

    model.setdefault("materials", {})[body.name] = mat
    model["metadata"]["n_materials"] = len(model["materials"])
    _save_canonical(project, model)
    return {"ok": True, "name": body.name, "data": mat}


@router.put("/{project_id}/model/materials/{name}")
async def update_material(
    project_id: str, name: str, body: MaterialUpdate, user: CurrentUser, db: DB
):
    """Actualiza un material existente y propaga E/G a las secciones que lo usan."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if name not in model.get("materials", {}):
        raise HTTPException(status_code=404, detail=f"Material '{name}' no encontrado")

    E, G = _auto_material_props(body.type, body.fpc_mpa, body.E_mpa, body.G_mpa, body.nu)
    mat: dict = {
        "type": body.type,
        "fpc_mpa": round(body.fpc_mpa, 2),
        "E_mpa": round(E, 1),
        "G_mpa": round(G, 1),
    }
    if body.fy_mpa > 0:
        mat["fy_mpa"] = round(body.fy_mpa, 2)

    model["materials"][name] = mat

    # Propagar E/G a las secciones que referencian este material
    for sec in model.get("sections", {}).values():
        if sec.get("material") == name:
            sec["E_mpa"] = round(E, 1)
            sec["G_mpa"] = round(G, 1)

    _save_canonical(project, model)
    return {"ok": True, "name": name, "data": mat}


@router.delete("/{project_id}/model/materials/{name}")
async def delete_material(project_id: str, name: str, user: CurrentUser, db: DB):
    """
    Elimina un material.
    Falla si alguna sección lo usa (el cliente debe reasignar primero).
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if name not in model.get("materials", {}):
        raise HTTPException(status_code=404, detail=f"Material '{name}' no encontrado")

    using = [sn for sn, sd in model.get("sections", {}).items() if sd.get("material") == name]
    if using:
        raise HTTPException(
            status_code=422,
            detail=(
                f"No se puede eliminar: {len(using)} sección(es) usan este material "
                f"({', '.join(using[:5])}). Reasigna las secciones primero."
            ),
        )

    del model["materials"][name]
    model["metadata"]["n_materials"] = len(model["materials"])
    _save_canonical(project, model)
    return {"ok": True, "deleted": name}


# ── Asignación de sección a frames ────────────────────────────────────────────

@router.post("/{project_id}/model/frames/assign-section")
async def assign_section_to_frames(
    project_id: str, body: AssignSectionBody, user: CurrentUser, db: DB
):
    """
    Asigna una sección a uno o más frames.
    Retorna también las secciones previas para soporte de undo en el cliente.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if body.section_name not in model.get("sections", {}):
        raise HTTPException(status_code=404, detail=f"Sección '{body.section_name}' no encontrada en el modelo")

    frames = model.get("frames", {})
    previous: dict[str, str] = {}
    updated: list[str] = []
    not_found: list[str] = []

    for fid in body.frame_ids:
        if fid in frames:
            previous[fid] = frames[fid].get("section", "")
            frames[fid]["section"] = body.section_name
            updated.append(fid)
        else:
            not_found.append(fid)

    _save_canonical(project, model)
    return {
        "ok": True,
        "section_assigned": body.section_name,
        "n_updated": len(updated),
        "n_not_found": len(not_found),
        "updated_ids": updated,
        "previous_sections": previous,   # para undo en el cliente
    }


@router.post("/{project_id}/model/frames/restore-sections")
async def restore_section_assignments(
    project_id: str, body: RestoreAssignmentsBody, user: CurrentUser, db: DB
):
    """
    Restaura asignaciones de sección previas.
    Usado exclusivamente por el mecanismo de undo del editor.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    frames = model.get("frames", {})

    restored = 0
    for fid, sec in body.assignments.items():
        if fid in frames:
            frames[fid]["section"] = sec
            restored += 1

    _save_canonical(project, model)
    return {"ok": True, "restored": restored}
