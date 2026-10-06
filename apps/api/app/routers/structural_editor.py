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


# ── Grid ──────────────────────────────────────────────────────────────────────

class GridAxis(BaseModel):
    name: str            # "A", "B", "1", "2"
    coord_m: float       # coordenada X (para ejes verticales) o Y (para horizontales)


class StoryDef(BaseModel):
    name: str
    height_m: float      # altura del piso (Δz respecto al piso inferior)


class GridDefinition(BaseModel):
    axes_x: list[GridAxis] = []   # líneas paralelas al eje Y (definen coordenada X)
    axes_y: list[GridAxis] = []   # líneas paralelas al eje X (definen coordenada Y)
    stories: list[StoryDef] = []  # de abajo hacia arriba; el primero es la base (z=0)


# ── Materiales de mampostería ─────────────────────────────────────────────────

class MasonryMaterialCreate(BaseModel):
    id: str                    # identificador único ("mamp_5_vp", "mamp_nsr10_D2", etc.)
    name: str                  # nombre legible
    fm_mpa: float              # resistencia a compresión (MPa)
    brick_type: str = "VP"     # "VP" | "HP" | "custom"
    Em_mpa: float | None = None  # obligatorio si brick_type == "custom"


class MasonryMaterialUpdate(BaseModel):
    name: str
    fm_mpa: float
    brick_type: str = "VP"
    Em_mpa: float | None = None


# ── Infills ──────────────────────────────────────────────────────────────────

class InfillPanelCreate(BaseModel):
    id: str
    # Dos columnas que delimitan el vano del panel. Son FIDs (claves) de
    # canonical["frames"] con element_type="column", ambas en el mismo story.
    column_i_fid: str = ""
    column_j_fid: str = ""
    story: str
    thickness_m: float
    masonry_material_id: str
    opening_ratio: float = 0.0    # 0 = sin abertura, 1 = totalmente abierto
    width_ratio: float = 0.25     # Mainstone simplificado; ∈ [0.05, 0.50]
    pier: str = ""                # legacy / etiqueta descriptiva opcional


class InfillPanelUpdate(BaseModel):
    column_i_fid: str = ""
    column_j_fid: str = ""
    story: str
    thickness_m: float
    masonry_material_id: str
    opening_ratio: float = 0.0
    width_ratio: float = 0.25
    pier: str = ""


class InfillReplicateRequest(BaseModel):
    source_infill_id: str
    target_stories: list[str]
    xy_tol_m: float = 0.3        # tolerancia para considerar columnas "alineadas" en planta
    id_prefix: str | None = None  # si None, se genera auto


# ── Elementos estructurales (para dibujo directo) ─────────────────────────────

class JointCreate(BaseModel):
    id: str
    x: float
    y: float
    z: float
    story: str = ""
    is_restrained: bool = False
    restraints: list[int] | None = None   # [ux,uy,uz,rx,ry,rz], 1=restringido


class FrameCreate(BaseModel):
    id: str
    joint_i: str
    joint_j: str
    section: str
    element_type: str = "column"   # "column" | "beam"
    story: str = ""


class ShellCreate(BaseModel):
    id: str
    joints: list[str]              # 3 o 4 nodos del contorno
    section: str = ""
    element_type: str = "wall"     # "wall" | "slab"
    thickness_m: float = 0.20
    pier: str = ""                 # solo aplica a walls
    story: str = ""


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
        "grid": model.get("grid", {}),
        "masonryMaterials": model.get("masonryMaterials", {}),
        "infills": model.get("infills", {}),
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


# ── Grid CRUD (definición de ejes por el usuario) ─────────────────────────────

@router.put("/{project_id}/model/grid")
async def upsert_grid(project_id: str, body: GridDefinition, user: CurrentUser, db: DB):
    """
    Persiste la definición de grid del usuario (ejes X/Y + pisos).
    El grid no reemplaza los joints existentes: es una referencia visual y
    de snap para el editor de dibujo. Los pisos aquí definidos alimentan
    también la sección "stories" para elementos nuevos que no tengan story.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    grid = {
        "axes_x": [{"name": a.name, "coord_m": round(a.coord_m, 4)} for a in body.axes_x],
        "axes_y": [{"name": a.name, "coord_m": round(a.coord_m, 4)} for a in body.axes_y],
        "stories": [{"name": s.name, "height_m": round(s.height_m, 4)} for s in body.stories],
    }
    model["grid"] = grid

    # Si hay pisos en el grid, sincroniza el diccionario "stories" del canonical
    # con elevaciones acumuladas desde la base.
    if body.stories:
        stories_dict = dict(model.get("stories", {}))
        z = 0.0
        for s in body.stories:
            z += float(s.height_m)
            if s.name not in stories_dict:
                stories_dict[s.name] = {}
            stories_dict[s.name]["elevation_m"] = round(z, 4)
            stories_dict[s.name]["height_m"] = round(s.height_m, 4)
        model["stories"] = stories_dict

    _save_canonical(project, model)
    return {"ok": True, "grid": grid}


# ── MasonryMaterial CRUD ──────────────────────────────────────────────────────

def _resolve_Em(brick_type: str, fm_mpa: float, Em_mpa: float | None) -> float:
    bt = (brick_type or "VP").upper()
    if Em_mpa is not None and Em_mpa > 0:
        return round(float(Em_mpa), 1)
    if bt == "VP":
        return round(775.0 * fm_mpa, 1)
    if bt == "HP":
        return round(622.0 * fm_mpa, 1)
    raise HTTPException(
        status_code=422,
        detail=f"brick_type='{brick_type}' requiere Em_mpa explícito.",
    )


@router.post("/{project_id}/model/masonry-materials")
async def create_masonry_material(
    project_id: str, body: MasonryMaterialCreate, user: CurrentUser, db: DB
):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.setdefault("masonryMaterials", {})

    if body.id in store:
        raise HTTPException(status_code=409, detail=f"Ya existe material '{body.id}'")
    if body.fm_mpa <= 0:
        raise HTTPException(status_code=422, detail="fm_mpa debe ser > 0")

    Em = _resolve_Em(body.brick_type, body.fm_mpa, body.Em_mpa)
    mat = {
        "id": body.id,
        "name": body.name,
        "fm_mpa": round(body.fm_mpa, 2),
        "brick_type": body.brick_type,
        "Em_mpa": Em,
    }
    store[body.id] = mat
    _save_canonical(project, model)
    return {"ok": True, "id": body.id, "data": mat}


@router.put("/{project_id}/model/masonry-materials/{material_id}")
async def update_masonry_material(
    project_id: str, material_id: str,
    body: MasonryMaterialUpdate, user: CurrentUser, db: DB,
):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.setdefault("masonryMaterials", {})
    if material_id not in store:
        raise HTTPException(status_code=404, detail=f"Material '{material_id}' no encontrado")
    if body.fm_mpa <= 0:
        raise HTTPException(status_code=422, detail="fm_mpa debe ser > 0")

    Em = _resolve_Em(body.brick_type, body.fm_mpa, body.Em_mpa)
    mat = {
        "id": material_id,
        "name": body.name,
        "fm_mpa": round(body.fm_mpa, 2),
        "brick_type": body.brick_type,
        "Em_mpa": Em,
    }
    store[material_id] = mat
    _save_canonical(project, model)
    return {"ok": True, "id": material_id, "data": mat}


@router.delete("/{project_id}/model/masonry-materials/{material_id}")
async def delete_masonry_material(
    project_id: str, material_id: str, user: CurrentUser, db: DB
):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.get("masonryMaterials", {})
    if material_id not in store:
        raise HTTPException(status_code=404, detail=f"Material '{material_id}' no encontrado")

    using = [
        iid for iid, ip in model.get("infills", {}).items()
        if ip.get("masonry_material_id") == material_id
    ]
    if using:
        raise HTTPException(
            status_code=422,
            detail=f"{len(using)} infill(s) usan este material. Elimínalos primero.",
        )

    del store[material_id]
    _save_canonical(project, model)
    return {"ok": True, "deleted": material_id}


# ── Infills CRUD ──────────────────────────────────────────────────────────────

def _validate_infill_body(model: dict, body: InfillPanelCreate | InfillPanelUpdate) -> None:
    if body.thickness_m <= 0:
        raise HTTPException(status_code=422, detail="thickness_m debe ser > 0")
    if not (0.0 <= body.opening_ratio <= 1.0):
        raise HTTPException(status_code=422, detail="opening_ratio ∈ [0, 1]")
    if not (0.05 <= body.width_ratio <= 0.50):
        raise HTTPException(status_code=422, detail="width_ratio ∈ [0.05, 0.50]")
    if body.masonry_material_id not in model.get("masonryMaterials", {}):
        raise HTTPException(
            status_code=422,
            detail=f"masonry_material_id='{body.masonry_material_id}' no existe.",
        )
    if body.story and body.story not in model.get("stories", {}):
        raise HTTPException(
            status_code=422,
            detail=f"story='{body.story}' no existe en el modelo.",
        )
    # Validación de columnas: si se proveen, deben existir en frames y ser columnas.
    frames = model.get("frames", {})
    for fid in (body.column_i_fid, body.column_j_fid):
        if not fid:
            continue
        fr = frames.get(fid)
        if not fr:
            raise HTTPException(
                status_code=422,
                detail=f"column fid='{fid}' no existe en canonical['frames'].",
            )
        if (fr.get("element_type") or "").lower() != "column":
            raise HTTPException(
                status_code=422,
                detail=f"frame '{fid}' no es una columna (element_type='{fr.get('element_type')}').",
            )
    if body.column_i_fid and body.column_i_fid == body.column_j_fid:
        raise HTTPException(
            status_code=422,
            detail="column_i_fid y column_j_fid deben ser columnas distintas.",
        )


@router.post("/{project_id}/model/infills")
async def create_infill(
    project_id: str, body: InfillPanelCreate, user: CurrentUser, db: DB
):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.setdefault("infills", {})

    if body.id in store:
        raise HTTPException(status_code=409, detail=f"Ya existe infill '{body.id}'")
    _validate_infill_body(model, body)

    panel = {
        "id": body.id,
        "column_i_fid": body.column_i_fid,
        "column_j_fid": body.column_j_fid,
        "pier": body.pier,
        "story": body.story,
        "thickness_m": round(body.thickness_m, 4),
        "masonry_material_id": body.masonry_material_id,
        "opening_ratio": round(body.opening_ratio, 3),
        "width_ratio": round(body.width_ratio, 3),
    }
    store[body.id] = panel
    _save_canonical(project, model)
    return {"ok": True, "id": body.id, "data": panel}


@router.put("/{project_id}/model/infills/{infill_id}")
async def update_infill(
    project_id: str, infill_id: str,
    body: InfillPanelUpdate, user: CurrentUser, db: DB,
):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.setdefault("infills", {})
    if infill_id not in store:
        raise HTTPException(status_code=404, detail=f"Infill '{infill_id}' no encontrado")
    _validate_infill_body(model, body)

    panel = {
        "id": infill_id,
        "column_i_fid": body.column_i_fid,
        "column_j_fid": body.column_j_fid,
        "pier": body.pier,
        "story": body.story,
        "thickness_m": round(body.thickness_m, 4),
        "masonry_material_id": body.masonry_material_id,
        "opening_ratio": round(body.opening_ratio, 3),
        "width_ratio": round(body.width_ratio, 3),
    }
    store[infill_id] = panel
    _save_canonical(project, model)
    return {"ok": True, "id": infill_id, "data": panel}


@router.post("/{project_id}/model/infills/replicate")
async def replicate_infill(
    project_id: str, body: InfillReplicateRequest, user: CurrentUser, db: DB,
):
    """
    Replica un panel de infill en varios pisos del edificio, mapeando las
    columnas homólogas por coordenada (x, y) del joint_j (tope de columna).

    Devuelve lista de paneles creados + razones por las que algún story no
    pudo replicarse.
    """
    project = _get_project(project_id, user, db)
    model   = _load_canonical(project)
    store   = model.setdefault("infills", {})
    source  = store.get(body.source_infill_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"Source infill '{body.source_infill_id}' no encontrado")

    frames  = model.get("frames",  {})
    joints  = model.get("joints",  {})
    stories = model.get("stories", {})
    tol     = max(0.05, float(body.xy_tol_m))

    def _col_top_xy(fid: str) -> tuple[float, float] | None:
        fr = frames.get(fid)
        if not fr: return None
        j = joints.get(fr.get("joint_j"))
        if not j: return None
        try:
            return (float(j.get("x", 0.0)), float(j.get("y", 0.0)))
        except (TypeError, ValueError):
            return None

    xy_i = _col_top_xy(source.get("column_i_fid", ""))
    xy_j = _col_top_xy(source.get("column_j_fid", ""))
    if not xy_i or not xy_j:
        raise HTTPException(status_code=422,
            detail="El panel source no tiene columnas con joints válidos.")

    # Agrupa columnas por story para búsqueda rápida.
    cols_by_story: dict[str, list[tuple[str, float, float]]] = {}
    for fid, fr in frames.items():
        if (fr.get("element_type") or "").lower() != "column":
            continue
        st = str(fr.get("story", ""))
        xy = _col_top_xy(fid)
        if not st or not xy:
            continue
        cols_by_story.setdefault(st, []).append((fid, xy[0], xy[1]))

    def _find_col(story: str, target_xy: tuple[float, float]) -> str | None:
        best_fid: str | None = None
        best_d2 = (tol * tol) + 1.0   # debe caer dentro del tol para ganar
        for fid, x, y in cols_by_story.get(story, []):
            d2 = (x - target_xy[0]) ** 2 + (y - target_xy[1]) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_fid = fid
        return best_fid

    created: list[dict] = []
    skipped: list[dict] = []
    prefix = (body.id_prefix or body.source_infill_id).rstrip("-_")

    for target in body.target_stories:
        if target not in stories:
            skipped.append({"story": target, "reason": "story no existe"})
            continue
        if target == source.get("story", ""):
            skipped.append({"story": target, "reason": "mismo story del source"})
            continue
        fi_new = _find_col(target, xy_i)
        fj_new = _find_col(target, xy_j)
        if not fi_new or not fj_new:
            skipped.append({"story": target,
                            "reason": "no se encontraron las 2 columnas homólogas"})
            continue
        # Evitar duplicados: si ya hay un panel con estas 2 columnas, saltar.
        existing = next((
            pid for pid, p in store.items()
            if p.get("story") == target and
               {p.get("column_i_fid"), p.get("column_j_fid")} == {fi_new, fj_new}
        ), None)
        if existing:
            skipped.append({"story": target, "reason": f"ya existe panel '{existing}' en ese vano"})
            continue
        # Generar id único
        base_id = f"{prefix}-{target}".replace(" ", "_")
        pid = base_id
        n = 2
        while pid in store:
            pid = f"{base_id}-{n}"
            n += 1
        panel = {
            "id":                  pid,
            "column_i_fid":        fi_new,
            "column_j_fid":        fj_new,
            "pier":                source.get("pier", ""),
            "story":               target,
            "thickness_m":         source["thickness_m"],
            "masonry_material_id": source["masonry_material_id"],
            "opening_ratio":       source["opening_ratio"],
            "width_ratio":         source["width_ratio"],
        }
        store[pid] = panel
        created.append(panel)

    _save_canonical(project, model)
    return {
        "ok":       True,
        "source":   body.source_infill_id,
        "created":  created,
        "skipped":  skipped,
        "n_created": len(created),
        "n_skipped": len(skipped),
    }


@router.delete("/{project_id}/model/infills/{infill_id}")
async def delete_infill(project_id: str, infill_id: str, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    store = model.get("infills", {})
    if infill_id not in store:
        raise HTTPException(status_code=404, detail=f"Infill '{infill_id}' no encontrado")
    del store[infill_id]
    _save_canonical(project, model)
    return {"ok": True, "deleted": infill_id}


# ── Joints CRUD (soporte dibujo) ──────────────────────────────────────────────

def _auto_story_for_z(model: dict, z: float) -> str:
    """Devuelve el nombre del story cuya elevation_m coincide con z (tolerancia)."""
    for name, s in model.get("stories", {}).items():
        if abs(float(s.get("elevation_m", 1e9)) - z) < 0.05:
            return name
    return ""


@router.post("/{project_id}/model/joints")
async def create_joint(project_id: str, body: JointCreate, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    joints = model.setdefault("joints", {})
    if body.id in joints:
        raise HTTPException(status_code=409, detail=f"Ya existe joint '{body.id}'")

    story = body.story or _auto_story_for_z(model, body.z)
    joint = {
        "x": round(body.x, 4),
        "y": round(body.y, 4),
        "z": round(body.z, 4),
        "story": story,
        "is_restrained": bool(body.is_restrained or (body.restraints and any(body.restraints))),
    }
    joints[body.id] = joint

    if body.restraints and len(body.restraints) == 6:
        model.setdefault("restraints", {})[body.id] = [int(v) for v in body.restraints]

    model["metadata"]["n_joints"] = len(joints)
    _save_canonical(project, model)
    return {"ok": True, "id": body.id, "data": joint}


@router.delete("/{project_id}/model/joints/{joint_id}")
async def delete_joint(project_id: str, joint_id: str, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    joints = model.get("joints", {})
    if joint_id not in joints:
        raise HTTPException(status_code=404, detail=f"Joint '{joint_id}' no encontrado")

    used_frames = [fid for fid, fd in model.get("frames", {}).items()
                   if fd.get("joint_i") == joint_id or fd.get("joint_j") == joint_id]
    used_shells = [sid for sid, sd in model.get("shells", {}).items()
                   if joint_id in sd.get("joints", [])]
    if used_frames or used_shells:
        raise HTTPException(
            status_code=422,
            detail=(
                f"El joint está en uso por {len(used_frames)} frame(s) y "
                f"{len(used_shells)} shell(s). Elimínalos primero."
            ),
        )
    del joints[joint_id]
    model.get("restraints", {}).pop(joint_id, None)
    model["metadata"]["n_joints"] = len(joints)
    _save_canonical(project, model)
    return {"ok": True, "deleted": joint_id}


# ── Frames CRUD (columnas + vigas) ────────────────────────────────────────────

@router.post("/{project_id}/model/frames")
async def create_frame(project_id: str, body: FrameCreate, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    frames = model.setdefault("frames", {})
    joints = model.get("joints", {})
    if body.id in frames:
        raise HTTPException(status_code=409, detail=f"Ya existe frame '{body.id}'")
    if body.joint_i not in joints or body.joint_j not in joints:
        raise HTTPException(status_code=422, detail="joint_i o joint_j no existen")
    if body.element_type not in ("column", "beam"):
        raise HTTPException(status_code=422, detail="element_type ∈ {column, beam}")
    if body.section and body.section not in model.get("sections", {}):
        raise HTTPException(status_code=422, detail=f"section '{body.section}' no existe")

    story = body.story or joints[body.joint_j].get("story", "") or joints[body.joint_i].get("story", "")
    frame = {
        "joint_i": body.joint_i,
        "joint_j": body.joint_j,
        "element_type": body.element_type,
        "story": story,
        "section": body.section or "",
    }
    frames[body.id] = frame
    model["metadata"]["n_frames"] = len(frames)
    _save_canonical(project, model)
    return {"ok": True, "id": body.id, "data": frame}


@router.delete("/{project_id}/model/frames/{frame_id}")
async def delete_frame(project_id: str, frame_id: str, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    frames = model.get("frames", {})
    if frame_id not in frames:
        raise HTTPException(status_code=404, detail=f"Frame '{frame_id}' no encontrado")
    del frames[frame_id]
    model["metadata"]["n_frames"] = len(frames)
    _save_canonical(project, model)
    return {"ok": True, "deleted": frame_id}


# ── Shells CRUD (muros + losas) ───────────────────────────────────────────────

@router.post("/{project_id}/model/shells")
async def create_shell(project_id: str, body: ShellCreate, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    shells = model.setdefault("shells", {})
    joints = model.get("joints", {})
    if body.id in shells:
        raise HTTPException(status_code=409, detail=f"Ya existe shell '{body.id}'")
    if body.element_type not in ("wall", "slab"):
        raise HTTPException(status_code=422, detail="element_type ∈ {wall, slab}")
    if len(body.joints) < 3:
        raise HTTPException(status_code=422, detail="Se requieren al menos 3 joints")
    missing = [j for j in body.joints if j not in joints]
    if missing:
        raise HTTPException(status_code=422, detail=f"Joints inexistentes: {missing[:5]}")
    if body.section and body.section not in model.get("sections", {}):
        raise HTTPException(status_code=422, detail=f"section '{body.section}' no existe")

    story = body.story or joints[body.joints[0]].get("story", "")
    shell = {
        "joints": list(body.joints),
        "section": body.section or "",
        "element_type": body.element_type,
        "story": story,
        "thickness_m": round(body.thickness_m, 4),
        "pier": body.pier or "",
    }
    shells[body.id] = shell
    model["metadata"]["n_shells"] = len(shells)
    _save_canonical(project, model)
    return {"ok": True, "id": body.id, "data": shell}


@router.delete("/{project_id}/model/shells/{shell_id}")
async def delete_shell(project_id: str, shell_id: str, user: CurrentUser, db: DB):
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    shells = model.get("shells", {})
    if shell_id not in shells:
        raise HTTPException(status_code=404, detail=f"Shell '{shell_id}' no encontrado")
    del shells[shell_id]
    model["metadata"]["n_shells"] = len(shells)
    _save_canonical(project, model)
    return {"ok": True, "deleted": shell_id}
