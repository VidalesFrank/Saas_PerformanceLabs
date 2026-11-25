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


class CopyStoryRequest(BaseModel):
    source_story: str
    target_story: str
    include_frames: bool = True    # columnas y vigas
    include_shells: bool = True    # muros y losas
    xy_tol_m: float = 0.05         # tolerancia para reusar joints existentes


class LoadPatternsRequest(BaseModel):
    patterns: list[str]


class LineLoadRequest(BaseModel):
    loads: dict[str, float]        # {pattern: wz_kN_m} — carga uniforme Z en viga


class ShellLoadRequest(BaseModel):
    loads: dict[str, float]        # {pattern: kN_m2} — presion uniforme sobre losa


class RigidDiaphragmsRequest(BaseModel):
    rigid_stories: list[str]       # lista de nombres de pisos con diafragma rigido


class ElementRef(BaseModel):
    kind: str                      # "column" | "beam" | "wall" | "slab"
    id:   str


class MirrorRequest(BaseModel):
    elements: list[ElementRef]
    axis:     str                  # "x" (refleja Y) | "y" (refleja X)
    coord:    float                # coordenada de la linea espejo
    xy_tol_m: float = 0.05


class ShellReplicateRequest(BaseModel):
    dx:    float
    dy:    float
    count: int                     # total incluyendo el original, min 2
    xy_tol_m: float = 0.05


class SteelSectionCreate(BaseModel):
    name:       str                # nombre user-facing de la seccion
    shape_name: str                # Nombre del perfil. Soporta:
                                   #   AISC:     "W24X55", "HSS8X8X1/2", "PIPE8STD"
                                   #   europeo:  "IPE-300", "HEA-200", "HEB-100", "HEM-240"
                                   #   PTE:      "PTE-200x100" (sin t; t se envia en thickness_mm)
                                   #   PHR:      "PHR-100"     (sin t; t se envia en thickness_mm)
    grade:      str = "A992"       # grado ASTM / DIN: "A36", "A572Gr50", "A992",
                                   # "A500GrB-Round", "A500GrC-Rect", "A913Gr65"
    thickness_mm: float | None = None   # espesor t del perfil tubular (PTE/PHR solamente)


# ── Lectura del modelo ────────────────────────────────────────────────────────

@router.get("/{project_id}/model/mixed-interfaces")
async def get_mixed_interfaces(project_id: str, user: CurrentUser, db: DB):
    """Lista de joints donde convergen elementos de concreto y de acero
    (apoyos de cubierta metálica sobre estructura RC, zonas de transición
    de material, bases de columnas metálicas sobre dados RC).

    Usado por la UI para:
        - Dibujar marcadores en el 3D viewer.
        - Avisar que el modelo tiene conexiones mixtas que deben verificarse
          (pinned para cerchas, rigid para columnas continuas, semi-rigid).
        - Pre-seleccionar `release` de los elementos de acero cuyo extremo
          cae en una interfaz de apoyo (default: pinned para roof_supports).
    """
    from app.engine.building.mixed_interface import (
        detect_mixed_interfaces, summarize_interfaces,
    )
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    interfaces = detect_mixed_interfaces(model)
    return {
        "interfaces": interfaces,
        "summary":    summarize_interfaces(interfaces),
    }


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
        "line_loads":  model.get("line_loads", {}),
        "shell_loads": model.get("shell_loads", {}),
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


@router.patch("/{project_id}/model/joints/{joint_id}")
async def update_joint(
    project_id: str, joint_id: str,
    body: dict,
    user: CurrentUser, db: DB,
):
    """Actualiza la posicion (x, y, z) de un joint. Los frames y shells que
    lo referencian se mueven con el automaticamente porque lo referencian por
    ID, no por coordenadas. Util para el drag en el editor 2D."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    joints = model.get("joints", {})
    if joint_id not in joints:
        raise HTTPException(status_code=404, detail=f"Joint '{joint_id}' no encontrado")

    j = joints[joint_id]
    for key in ("x", "y", "z"):
        if key in body:
            try:
                j[key] = round(float(body[key]), 4)
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail=f"{key} debe ser numerico")
    if "story" in body:
        j["story"] = str(body["story"] or "")

    _save_canonical(project, model)
    return {"ok": True, "id": joint_id, "data": j}


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


@router.patch("/{project_id}/model/frames/{frame_id}")
async def update_frame(
    project_id: str, frame_id: str, body: dict,
    user: CurrentUser, db: DB,
):
    """Actualiza seccion, release y/o story de un frame. Campos ausentes
    no se tocan. release ∈ {"", "i", "j", "ij"} (convencion string)."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    frames = model.get("frames", {})
    if frame_id not in frames:
        raise HTTPException(status_code=404, detail=f"Frame '{frame_id}' no encontrado")

    fd = frames[frame_id]
    if "section" in body:
        section = str(body["section"] or "")
        if section and section not in model.get("sections", {}):
            raise HTTPException(status_code=422, detail=f"section '{section}' no existe")
        fd["section"] = section
    if "release" in body:
        rel = str(body["release"] or "")
        if rel not in ("", "i", "j", "ij"):
            raise HTTPException(status_code=422, detail="release ∈ {'', 'i', 'j', 'ij'}")
        if rel:
            fd["release"] = rel
        else:
            fd.pop("release", None)
    if "story" in body:
        fd["story"] = str(body["story"] or "")

    _save_canonical(project, model)
    return {"ok": True, "id": frame_id, "data": fd}


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


# ── Copiar piso completo (replicar elementos a otro story) ────────────────────

@router.post("/{project_id}/model/stories/copy")
async def copy_story(project_id: str, body: CopyStoryRequest, user: CurrentUser, db: DB):
    """Duplica todos los elementos (columnas + vigas + muros + losas) del piso
    `source_story` al piso `target_story`.

    Convención ETABS: un elemento "pertenece" a un story cuando su joint_j (top)
    está en la elevación de ese story. Los joints se translan verticalmente por
    `delta = target_elev - source_elev` (y análogamente para los bottom-joints
    de columnas). Si ya existe un joint cercano (dentro de xy_tol_m) en la
    elevación destino, se reusa en vez de crear uno nuevo.

    Returns: resumen de elementos nuevos + warnings.
    """
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if body.source_story == body.target_story:
        raise HTTPException(status_code=422, detail="source_story y target_story deben ser distintos")

    stories = model.get("stories", {})
    if body.source_story not in stories:
        raise HTTPException(status_code=422, detail=f"source_story '{body.source_story}' no existe")
    if body.target_story not in stories:
        raise HTTPException(status_code=422, detail=f"target_story '{body.target_story}' no existe")

    src = stories[body.source_story]
    tgt = stories[body.target_story]
    src_top    = float(src.get("elevation_m", 0.0))
    src_h      = float(src.get("height_m", 0.0))
    src_bottom = src_top - src_h
    tgt_top    = float(tgt.get("elevation_m", 0.0))
    tgt_h      = float(tgt.get("height_m", src_h))
    tgt_bottom = tgt_top - tgt_h

    joints = model.setdefault("joints", {})
    frames = model.setdefault("frames", {})
    shells = model.setdefault("shells", {})
    tol    = float(body.xy_tol_m)

    joint_map: dict[str, str] = {}   # old_id -> new_id
    joints_created: list[str] = []
    joints_reused:  list[str] = []
    warnings:       list[str] = []

    def _unique_id(prefix: str, pool: dict) -> str:
        """Genera un ID único añadiendo sufijo numérico si hay colisión."""
        if prefix not in pool:
            return prefix
        n = 1
        while f"{prefix}_{n}" in pool:
            n += 1
        return f"{prefix}_{n}"

    def _ensure_joint_at_target(old_id: str, level: str) -> str | None:
        """Obtiene o crea un joint destino.

        level ∈ {"top", "bottom"} indica si el joint original estaba en el
        top o bottom del source story → queda en el nivel análogo del target.
        """
        if old_id in joint_map:
            return joint_map[old_id]
        j = joints.get(old_id)
        if j is None:
            warnings.append(f"Joint '{old_id}' referenciado no existe; se omite elemento")
            return None
        x = float(j.get("x", 0.0))
        y = float(j.get("y", 0.0))
        new_z = tgt_top if level == "top" else tgt_bottom

        # Reusar joint existente si hay uno cercano en la elevación destino
        for jid, jd in joints.items():
            if (abs(float(jd.get("x", 0.0)) - x) < tol
                and abs(float(jd.get("y", 0.0)) - y) < tol
                and abs(float(jd.get("z", 0.0)) - new_z) < tol):
                joint_map[old_id] = jid
                joints_reused.append(jid)
                return jid

        # Crear joint nuevo
        new_id = _unique_id(f"{old_id}__{body.target_story}", joints)
        joints[new_id] = {
            "x": round(x, 4),
            "y": round(y, 4),
            "z": round(new_z, 4),
            "story": body.target_story,
            "is_restrained": False,
        }
        joint_map[old_id] = new_id
        joints_created.append(new_id)
        return new_id

    frames_created: list[str] = []
    shells_created: list[str] = []

    # Frames (columnas y vigas) del source
    if body.include_frames:
        source_frames = [(fid, fd) for fid, fd in list(frames.items())
                         if fd.get("story") == body.source_story]
        for fid, fd in source_frames:
            el_type = fd.get("element_type")
            if el_type not in ("column", "beam"):
                continue
            ji_old = fd.get("joint_i")
            jj_old = fd.get("joint_j")
            ji = joints.get(ji_old, {})
            jj = joints.get(jj_old, {})
            if not ji or not jj:
                warnings.append(f"Frame '{fid}' tiene joints faltantes; se omite")
                continue

            # Determinar nivel por z (robusto a joints reordenados)
            z_i = float(ji.get("z", 0.0))
            z_j = float(jj.get("z", 0.0))

            def level_of(z: float) -> str:
                if abs(z - src_top) < tol:    return "top"
                if abs(z - src_bottom) < tol: return "bottom"
                return "top"  # fallback para beams: todos sus joints están en src_top

            lvl_i = level_of(z_i)
            lvl_j = level_of(z_j)

            new_ji = _ensure_joint_at_target(ji_old, lvl_i)
            new_jj = _ensure_joint_at_target(jj_old, lvl_j)
            if new_ji is None or new_jj is None:
                continue

            new_fid = _unique_id(f"{fid}__{body.target_story}", frames)
            frames[new_fid] = {
                "joint_i":      new_ji,
                "joint_j":      new_jj,
                "element_type": el_type,
                "story":        body.target_story,
                "section":      fd.get("section", ""),
            }
            if fd.get("release"):
                frames[new_fid]["release"] = fd["release"]
            frames_created.append(new_fid)

    # Shells (muros y losas) del source
    if body.include_shells:
        source_shells = [(sid, sd) for sid, sd in list(shells.items())
                         if sd.get("story") == body.source_story]
        for sid, sd in source_shells:
            el_type = sd.get("element_type")
            if el_type not in ("wall", "slab"):
                continue

            new_joints: list[str] = []
            skip = False
            for jid_old in sd.get("joints", []):
                j = joints.get(jid_old, {})
                if not j:
                    warnings.append(f"Shell '{sid}' tiene joints faltantes; se omite")
                    skip = True
                    break
                z = float(j.get("z", 0.0))
                lvl = "top" if abs(z - src_top) < tol else "bottom"
                new_jid = _ensure_joint_at_target(jid_old, lvl)
                if new_jid is None:
                    skip = True
                    break
                new_joints.append(new_jid)
            if skip or len(new_joints) < 3:
                continue

            new_sid = _unique_id(f"{sid}__{body.target_story}", shells)
            shells[new_sid] = {
                "joints":       new_joints,
                "section":      sd.get("section", ""),
                "element_type": el_type,
                "story":        body.target_story,
                "thickness_m":  float(sd.get("thickness_m", 0.2)),
                "pier":         sd.get("pier", ""),
            }
            shells_created.append(new_sid)

    # Actualizar contadores del metadata
    model["metadata"]["n_joints"] = len(joints)
    model["metadata"]["n_frames"] = len(frames)
    model["metadata"]["n_shells"] = len(shells)

    _save_canonical(project, model)

    return {
        "ok": True,
        "source_story":    body.source_story,
        "target_story":    body.target_story,
        "joints_created":  len(joints_created),
        "joints_reused":   len(joints_reused),
        "frames_created":  len(frames_created),
        "shells_created":  len(shells_created),
        "warnings":        warnings,
        "new_ids": {
            "joints": joints_created,
            "frames": frames_created,
            "shells": shells_created,
        },
    }


# ── Cargas: patrones + line_loads (vigas) + shell_loads (losas) ───────────────

@router.put("/{project_id}/model/load-patterns")
async def upsert_load_patterns(
    project_id: str, body: LoadPatternsRequest, user: CurrentUser, db: DB,
):
    """Reemplaza la lista completa de patrones de carga (DL, LL, SDL, EQX, etc.).
    Al borrar un patron, se eliminan en cascada todas las cargas asignadas a el
    (tanto line_loads como shell_loads). Devuelve la lista final + cargas
    huerfanas removidas."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    # Dedup y normaliza
    new_patterns = sorted({p.strip() for p in body.patterns if p and p.strip()})
    old_patterns = list(model.get("metadata", {}).get("load_patterns", []))
    removed = [p for p in old_patterns if p not in new_patterns]

    model.setdefault("metadata", {})["load_patterns"] = new_patterns
    # Mantener tambien el campo legacy load_patterns para compat con shells import
    if "load_patterns" in model:
        model["load_patterns"] = new_patterns

    # Cascade: limpiar line_loads y shell_loads de patrones removidos
    line_loads  = model.setdefault("line_loads",  {})
    shell_loads = model.setdefault("shell_loads", {})
    n_line_cleaned, n_shell_cleaned = 0, 0
    for fid, lmap in list(line_loads.items()):
        for p in removed:
            if p in lmap:
                del lmap[p]; n_line_cleaned += 1
        if not lmap:
            del line_loads[fid]
    for sid, lmap in list(shell_loads.items()):
        for p in removed:
            if p in lmap:
                del lmap[p]; n_shell_cleaned += 1
        if not lmap:
            del shell_loads[sid]

    _save_canonical(project, model)
    return {
        "ok": True,
        "patterns": new_patterns,
        "removed_patterns": removed,
        "line_loads_cleaned": n_line_cleaned,
        "shell_loads_cleaned": n_shell_cleaned,
    }


@router.put("/{project_id}/model/line-loads/{frame_id}")
async def upsert_line_load(
    project_id: str, frame_id: str, body: LineLoadRequest,
    user: CurrentUser, db: DB,
):
    """Asigna cargas lineales uniformes (kN/m, direccion gravitacional Z) a
    una viga para uno o varios patrones. Reemplaza las cargas previas del
    frame. Patron 'pattern: 0' elimina la asignacion de ese patron."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if frame_id not in model.get("frames", {}):
        raise HTTPException(status_code=404, detail=f"Frame '{frame_id}' no encontrado")

    valid_patterns = set(model.get("metadata", {}).get("load_patterns", []))
    unknown = [p for p in body.loads if p not in valid_patterns]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Patrones desconocidos: {unknown}. Crealos primero en load-patterns.",
        )

    line_loads = model.setdefault("line_loads", {})
    current = line_loads.get(frame_id, {})
    for p, val in body.loads.items():
        try:
            v = float(val)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"Valor no numerico para '{p}'")
        if abs(v) < 1e-9:
            current.pop(p, None)
        else:
            current[p] = round(v, 4)
    if current:
        line_loads[frame_id] = current
    else:
        line_loads.pop(frame_id, None)

    _save_canonical(project, model)
    return {"ok": True, "frame_id": frame_id, "loads": current}


@router.put("/{project_id}/model/shell-loads/{shell_id}")
async def upsert_shell_load(
    project_id: str, shell_id: str, body: ShellLoadRequest,
    user: CurrentUser, db: DB,
):
    """Asigna presion uniforme (kN/m^2, gravitacional) a una losa por patron.
    Reemplaza las cargas previas del shell. Patron 'pattern: 0' elimina la
    asignacion de ese patron."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if shell_id not in model.get("shells", {}):
        raise HTTPException(status_code=404, detail=f"Shell '{shell_id}' no encontrado")

    valid_patterns = set(model.get("metadata", {}).get("load_patterns", []))
    unknown = [p for p in body.loads if p not in valid_patterns]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Patrones desconocidos: {unknown}. Crealos primero en load-patterns.",
        )

    shell_loads = model.setdefault("shell_loads", {})
    current = shell_loads.get(shell_id, {})
    for p, val in body.loads.items():
        try:
            v = float(val)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"Valor no numerico para '{p}'")
        if abs(v) < 1e-9:
            current.pop(p, None)
        else:
            current[p] = round(v, 4)
    if current:
        shell_loads[shell_id] = current
    else:
        shell_loads.pop(shell_id, None)

    _save_canonical(project, model)
    return {"ok": True, "shell_id": shell_id, "loads": current}


# ── Diafragmas rigidos por piso ──────────────────────────────────────────────

@router.put("/{project_id}/model/rigid-diaphragms")
async def upsert_rigid_diaphragms(
    project_id: str, body: RigidDiaphragmsRequest,
    user: CurrentUser, db: DB,
):
    """Define que pisos tienen diafragma rigido (todos los joints del piso
    quedan master-slaved al centro de masas del piso durante el analisis).
    Reemplaza la lista completa."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    stories = model.get("stories", {})
    unknown = [s for s in body.rigid_stories if s not in stories]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Pisos desconocidos: {unknown}. Deben existir en el grid.",
        )

    rigid_sorted = sorted(set(s for s in body.rigid_stories if s))
    model.setdefault("metadata", {})["rigid_diaphragms"] = rigid_sorted
    _save_canonical(project, model)
    return {"ok": True, "rigid_diaphragms": rigid_sorted}


# ── Mirror + Shell replicate (completan Fase 2 de edicion) ───────────────────

def _unique_model_id(prefix: str, pool: dict) -> str:
    """Devuelve un ID unico anadiendo sufijo numerico."""
    if prefix not in pool:
        return prefix
    n = 1
    while f"{prefix}_{n}" in pool:
        n += 1
    return f"{prefix}_{n}"


def _ensure_joint_at(
    joints: dict, src_id: str, new_xyz: tuple[float, float, float],
    tol: float, suffix: str,
) -> str:
    """Obtiene o crea un joint en la posicion `new_xyz`. Si ya existe uno
    cerca (dentro de tol en X, Y, Z) lo reusa. Retorna el ID final."""
    nx, ny, nz = new_xyz
    # Reuse existente
    for jid, jd in joints.items():
        if (abs(float(jd.get("x", 0.0)) - nx) < tol
            and abs(float(jd.get("y", 0.0)) - ny) < tol
            and abs(float(jd.get("z", 0.0)) - nz) < tol):
            return jid
    # Crear nuevo
    src = joints.get(src_id, {})
    new_id = _unique_model_id(f"{src_id}{suffix}", joints)
    joints[new_id] = {
        "x": round(nx, 4),
        "y": round(ny, 4),
        "z": round(nz, 4),
        "story": src.get("story", ""),
        "is_restrained": False,
    }
    return new_id


@router.post("/{project_id}/model/mirror")
async def mirror_elements(
    project_id: str, body: MirrorRequest, user: CurrentUser, db: DB,
):
    """Refleja elementos (columnas, vigas, muros, losas) a traves de una linea
    paralela al eje X o Y a la coordenada `coord`.
        - axis="x": espejo horizontal (refleja la coordenada Y: y → 2*coord - y)
        - axis="y": espejo vertical    (refleja la coordenada X: x → 2*coord - x)
    Crea joints nuevos y elementos nuevos. Reusa joints existentes cercanos."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    joints = model.setdefault("joints", {})
    frames = model.setdefault("frames", {})
    shells = model.setdefault("shells", {})
    tol    = float(body.xy_tol_m)

    if body.axis not in ("x", "y"):
        raise HTTPException(status_code=422, detail="axis ∈ {'x', 'y'}")

    def reflect(j: dict) -> tuple[float, float, float]:
        x, y, z = float(j.get("x", 0.0)), float(j.get("y", 0.0)), float(j.get("z", 0.0))
        if body.axis == "x":
            return x, 2 * body.coord - y, z
        else:
            return 2 * body.coord - x, y, z

    joint_map: dict[str, str] = {}
    def mapped(src_id: str) -> str:
        if src_id in joint_map:
            return joint_map[src_id]
        j = joints.get(src_id)
        if j is None:
            raise HTTPException(status_code=422, detail=f"Joint '{src_id}' no existe")
        new_id = _ensure_joint_at(joints, src_id, reflect(j), tol, "__mir")
        joint_map[src_id] = new_id
        return new_id

    frames_created: list[str] = []
    shells_created: list[str] = []
    warnings:       list[str] = []

    for el in body.elements:
        if el.kind in ("column", "beam"):
            fd = frames.get(el.id)
            if not fd:
                warnings.append(f"Frame '{el.id}' no existe"); continue
            new_ji = mapped(fd["joint_i"])
            new_jj = mapped(fd["joint_j"])
            new_id = _unique_model_id(f"{el.id}__mir", frames)
            frames[new_id] = {
                "joint_i": new_ji, "joint_j": new_jj,
                "element_type": fd["element_type"],
                "story": fd.get("story", ""),
                "section": fd.get("section", ""),
            }
            if fd.get("release"):
                frames[new_id]["release"] = fd["release"]
            frames_created.append(new_id)
        elif el.kind in ("wall", "slab"):
            sd = shells.get(el.id)
            if not sd:
                warnings.append(f"Shell '{el.id}' no existe"); continue
            new_joints = [mapped(j) for j in sd.get("joints", [])]
            if len(new_joints) < 3:
                warnings.append(f"Shell '{el.id}' tiene <3 joints"); continue
            # Para muros/losas, invertir orden de joints para mantener orientacion
            # del normal del polígono tras la reflexion (evita polígono invertido).
            new_joints = list(reversed(new_joints))
            new_id = _unique_model_id(f"{el.id}__mir", shells)
            shells[new_id] = {
                "joints": new_joints,
                "section": sd.get("section", ""),
                "element_type": sd["element_type"],
                "story": sd.get("story", ""),
                "thickness_m": float(sd.get("thickness_m", 0.2)),
                "pier": sd.get("pier", ""),
            }
            shells_created.append(new_id)
        else:
            warnings.append(f"Kind desconocido '{el.kind}'")

    model["metadata"]["n_joints"] = len(joints)
    model["metadata"]["n_frames"] = len(frames)
    model["metadata"]["n_shells"] = len(shells)
    _save_canonical(project, model)
    return {
        "ok": True,
        "frames_created": len(frames_created),
        "shells_created": len(shells_created),
        "joints_reused":  sum(1 for _ in joint_map),  # estimado
        "warnings": warnings,
        "new_ids": {"frames": frames_created, "shells": shells_created},
    }


@router.post("/{project_id}/model/shells/{shell_id}/replicate")
async def replicate_shell(
    project_id: str, shell_id: str, body: ShellReplicateRequest,
    user: CurrentUser, db: DB,
):
    """Replica un muro o losa en array lineal: N-1 copias trasladadas por
    multiplos de (dx, dy). Reusa joints existentes cercanos."""
    project = _get_project(project_id, user, db)
    model = _load_canonical(project)
    shells = model.setdefault("shells", {})
    joints = model.setdefault("joints", {})

    sd = shells.get(shell_id)
    if not sd:
        raise HTTPException(status_code=404, detail=f"Shell '{shell_id}' no encontrado")
    if body.count < 2:
        raise HTTPException(status_code=422, detail="count debe ser >= 2")
    if abs(body.dx) + abs(body.dy) < 0.001:
        raise HTTPException(status_code=422, detail="Offset Δx o Δy necesario")

    count  = min(body.count, 50)
    copies = count - 1
    tol    = float(body.xy_tol_m)

    shells_created: list[str] = []
    for k in range(1, copies + 1):
        odx, ody = body.dx * k, body.dy * k
        new_joints: list[str] = []
        for src_jid in sd.get("joints", []):
            src = joints.get(src_jid, {})
            new_jid = _ensure_joint_at(
                joints, src_jid,
                (float(src.get("x", 0.0)) + odx,
                 float(src.get("y", 0.0)) + ody,
                 float(src.get("z", 0.0))),
                tol, f"__r{k}",
            )
            new_joints.append(new_jid)
        new_sid = _unique_model_id(f"{shell_id}__r{k}", shells)
        shells[new_sid] = {
            "joints":       new_joints,
            "section":      sd.get("section", ""),
            "element_type": sd["element_type"],
            "story":        sd.get("story", ""),
            "thickness_m":  float(sd.get("thickness_m", 0.2)),
            "pier":         sd.get("pier", ""),
        }
        shells_created.append(new_sid)

    model["metadata"]["n_joints"] = len(joints)
    model["metadata"]["n_shells"] = len(shells)
    _save_canonical(project, model)
    return {"ok": True, "shells_created": len(shells_created), "new_ids": shells_created}


# ── Catalogo de perfiles AISC + secciones de acero ───────────────────────────

@router.get("/steel/catalog")
async def get_steel_catalog(user: CurrentUser):
    """Devuelve el catalogo de perfiles metalicos (AISC + europeos + colombianos
    tubulares) + grados ASTM/DIN. Usado por la UI para poblar los dropdowns
    del tab "Acero" en /sections.

    Estructura:
        - shapes_by_type: { "W": [...], "IPE": [...], "HEA": [...], "HEB": [...],
                             "HEM": [...], "HSS_RECT": [...], "PIPE": [...], ... }
        - parametric_shapes: { "PTE": {sizes, default_thicknesses}, "PHR": {...} }
          — perfiles cuyo espesor lo define el usuario al crear la seccion.
    """
    from engine.materials.structural_steel import GRADE_PRESETS
    from engine.sections.steel_shapes import (
        ALL_SHAPES,
        PTE_NOMINAL_SIZES, PTE_DEFAULT_THICKNESSES,
        PHR_NOMINAL_OD,    PHR_DEFAULT_THICKNESSES,
    )

    # Catalogo tabulado (AISC + europeos DIN). PTE/PHR NO aparecen aqui.
    shapes_by_type: dict[str, list[dict]] = {}
    for name, s in ALL_SHAPES.items():
        key = s.type.value
        shapes_by_type.setdefault(key, []).append({
            "name": name,
            "A_mm2": round(s.A, 1),
            "d_mm":  round(s.d, 1),
            "bf_mm": round(s.bf, 1),
            "weight_kgm": round(s.weight_kgm, 2),
            "Ix_mm4": round(s.Ix, 1),
            "Iy_mm4": round(s.Iy, 1),
            "Zx_mm3": round(s.Zx, 1),
            "Zy_mm3": round(s.Zy, 1),
        })
    for key in shapes_by_type:
        # Ordenar por peralte para europeos/AISC; mantener orden alfabetico si no.
        shapes_by_type[key].sort(key=lambda d: (d["d_mm"], d["name"]))

    parametric_shapes = {
        "PTE": {
            "label": "PTE — Perfil Tubular Estructural rectangular",
            "sizes": [
                {"name": f"PTE-{int(d) if d == int(d) else d}x{int(b) if b == int(b) else b}",
                 "d_mm": d, "b_mm": b}
                for (d, b) in PTE_NOMINAL_SIZES
            ],
            "default_thicknesses_mm": PTE_DEFAULT_THICKNESSES,
            "user_adjustable_thickness": True,
        },
        "PHR": {
            "label": "PHR — Perfil Hueco Redondo",
            "sizes": [
                {"name": f"PHR-{int(od) if od == int(od) else od}", "OD_mm": od}
                for od in PHR_NOMINAL_OD
            ],
            "default_thicknesses_mm": PHR_DEFAULT_THICKNESSES,
            "user_adjustable_thickness": True,
        },
    }

    grades = [
        {
            "name":  p.grade,
            "fy_mpa": p.fy,
            "fu_mpa": p.fu,
            "E_mpa": p.E0,
            "G_mpa": p.G,
            "eps_y": round(p.eps_y, 5),
        }
        for p in GRADE_PRESETS.values()
    ]

    return {
        "shapes_by_type": shapes_by_type,
        "parametric_shapes": parametric_shapes,
        "grades": grades,
        "total_shapes": len(ALL_SHAPES),
    }


@router.post("/{project_id}/model/steel-sections")
async def create_steel_section(
    project_id: str, body: SteelSectionCreate,
    user: CurrentUser, db: DB,
):
    """Crea una seccion metalica usando un perfil (AISC/DIN/colombiano) + grado
    ASTM o DIN. Auto-crea el material de acero si no existe. Computa A/Iy/Iz/J
    en SI (m²/m⁴) desde el SteelFrameSection y los almacena en el schema
    estandar de `sections` para que el `ops_builder` los consuma transparente.

    Para PTE/PHR, el campo `thickness_mm` del body define el espesor t del
    tubo. En ese caso el `shape_name` debe ser una dimension nominal:
    `PTE-200x100` (sin t) o `PHR-100` (sin t). Se forma el nombre final
    agregando el espesor: `PTE-200x100x5` / `PHR-100x3`.
    """
    from engine.sections.steel_section import (
        make_steel_section, make_pte_section, make_phr_section,
    )

    project = _get_project(project_id, user, db)
    model = _load_canonical(project)

    if body.name in model.get("sections", {}):
        raise HTTPException(status_code=409, detail=f"Ya existe una seccion '{body.name}'")

    # Dispatch PTE/PHR (parametricos) vs catalogo tabulado.
    shape_upper = body.shape_name.upper().replace(" ", "")
    try:
        if shape_upper.startswith("PTE-") and body.thickness_mm:
            # "PTE-200x100" -> parse dims
            dims = shape_upper.removeprefix("PTE-").split("X")
            if len(dims) not in (2, 3):
                raise HTTPException(
                    status_code=422,
                    detail=f"PTE: formato invalido '{body.shape_name}'. Esperado 'PTE-<d>x<b>'.",
                )
            d_mm, b_mm = float(dims[0]), float(dims[1])
            sf = make_pte_section(d_mm, b_mm, float(body.thickness_mm), body.grade)
        elif shape_upper.startswith("PHR-") and body.thickness_mm:
            dims = shape_upper.removeprefix("PHR-").split("X")
            OD_mm = float(dims[0])
            sf = make_phr_section(OD_mm, float(body.thickness_mm), body.grade)
        else:
            sf = make_steel_section(body.shape_name, body.grade)
    except KeyError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Auto-crear material de acero si no existe. Nombre canonico: "Steel_<grade>".
    mat_name = f"Steel_{body.grade}"
    materials = model.setdefault("materials", {})
    if mat_name not in materials:
        materials[mat_name] = {
            "type":    "steel",
            "fpc_mpa": 0.0,                       # no aplica para acero
            "fy_mpa":  round(sf.material.fy, 2),
            "E_mpa":   round(sf.material.E0, 1),
            "G_mpa":   round(sf.material.G,  1),
        }
        model["metadata"]["n_materials"] = len(materials)

    # Convertir propiedades AISC (mm, mm², mm³, mm⁴) → SI (m, m², m³, m⁴)
    # Las propiedades del SteelFrameSection vienen en mm. ops_builder espera m.
    MM2_TO_M2 = 1e-6
    MM4_TO_M4 = 1e-12

    # Para PTE/PHR, usar el nombre final (con espesor) en lugar del nominal.
    final_shape_label = sf.shape.name if sf.type.value in ("PTE", "PHR") else body.shape_name

    sec = {
        "material":    mat_name,
        "shape":       "steel",                   # tipo logico — ops_builder y UI
        "shape_type":  "steel",                   # redundante pero explicito
        "steel_grade": body.grade,
        "steel_shape": final_shape_label,         # etiqueta AISC/DIN para preview
        "aisc_type":   sf.type.value,             # W | HSS_RECT | PIPE | IPE | HEA | PTE | PHR | ...
        # Dimensiones en m (algunas para preview, no todas aplican a todos los shapes)
        "h_m":         round(sf.shape.d  * 1e-3, 4),
        "b_m":         round(sf.shape.bf * 1e-3, 4),
        "tw_m":        round(sf.shape.tw * 1e-3, 5),
        "tf_m":        round(sf.shape.tf * 1e-3, 5),
        "t_des_m":     round(sf.shape.t_des * 1e-3, 5),
        "OD_m":        round(sf.shape.OD * 1e-3, 4),
        # Propiedades geometricas en SI — consumidas por ops_builder
        "A_m2":        round(sf.A  * MM2_TO_M2, 8),
        "I33_m4":      round(sf.Iz * MM4_TO_M4, 12),   # eje fuerte (AISC Ix)
        "I22_m4":      round(sf.Iy * MM4_TO_M4, 12),   # eje debil  (AISC Iy)
        "J_m4":        round(sf.J  * MM4_TO_M4, 12),
        "E_mpa":       round(sf.E, 1),
        "G_mpa":       round(sf.G, 1),
        # Modulos de diseno (AISC F / H)
        "Zx_m3":       round(sf.Zx * 1e-9, 9),
        "Zy_m3":       round(sf.Zy * 1e-9, 9),
        "Sx_m3":       round(sf.Sx * 1e-9, 9),
        "Sy_m3":       round(sf.Sy * 1e-9, 9),
        "Mp_x_kNm":    round(sf.Mp_x * 1e-6, 2),       # N·mm → kN·m
        "Mp_y_kNm":    round(sf.Mp_y * 1e-6, 2),
        "Py_kN":       round(sf.Py  * 1e-3, 2),
    }
    model.setdefault("sections", {})[body.name] = sec
    model["metadata"]["n_sections"] = len(model["sections"])
    _save_canonical(project, model)
    return {"ok": True, "name": body.name, "data": sec, "material_created": mat_name}
