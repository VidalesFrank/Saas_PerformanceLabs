"""
Router — Módulo 1: Constructor de Modelos Estructurales.
Gestión de proyectos: CRUD + carga de archivos.

Prefix: /api/v1/projects
Auth:   JWT requerido en todos los endpoints.

Cada proyecto representa un edificio importado desde ETABS (XLSX o .e2k).
El flujo es: crear proyecto → subir archivo → validar → analizar (modal → espectral).
"""
import json
import os
import shutil
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.models import StructuralProject, StructuralJob, User

router = APIRouter(prefix="/api/v1/projects", tags=["structural-projects"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str | None = None


class ProjectUpdate(BaseModel):
    """Campos editables de un proyecto ya creado. Ambos opcionales — el PATCH
    sólo actualiza los campos presentes. Los parámetros sísmicos NO se tocan
    aquí (cambiarlos equivale a otro modelo). Jobs y archivos tampoco."""
    name: str | None = None
    description: str | None = None


class SeismicParameters(BaseModel):
    """Parámetros sísmicos NSR-10 y configuración del análisis."""
    # Identificación
    code: str = "NSR-10"

    # Ubicación y amenaza sísmica
    city: str
    department: str | None = None
    Aa: float | None = None          # aceleración pico efectiva (de la tabla NSR-10 o municipio)
    Av: float | None = None          # velocidad pico efectiva
    seismic_zone: str | None = None  # zona de amenaza: baja / intermedia / alta
    soil_type: str                   # A / B / C / D / E

    # Grupo de uso e importancia
    edification_use: str             # I / II / III / IV
    importance_factor: float = 1.0   # factor I (NSR-10 A.2.5)

    # Sistema estructural
    structure_system: str            # RCMRF / WRCF / DUAL
    energy_dissipation: str = "DMO"  # DMO / DES / DES_ESP
    R: float | None = None           # factor de reducción de fuerza sísmica
    Ct: float | None = None          # coeficiente para período empírico
    alpha_x: float | None = None     # exponente para período empírico

    # Parámetros de análisis
    damping_ratio: float = 0.05      # amortiguamiento (fracción)
    n_modes: int = 12                # número de modos a calcular
    combination_method: str = "CQC"  # CQC / SRSS

    # Nombres de patrones de carga en el modelo
    cm_load: str = "DEAD"
    cv_load: str = "LIVE"


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    parameters_json: dict | None = None
    input_file_path: str | None
    e2k_file_path: str | None
    canonical_model_path: str | None
    validation_status: str
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_extra(cls, p: StructuralProject) -> "ProjectOut":
        params = None
        if p.parameters_json:
            try:
                params = json.loads(p.parameters_json)
            except Exception:
                pass
        return cls(
            id=p.id, name=p.name, description=p.description,
            parameters_json=params,
            input_file_path=p.input_file_path,
            e2k_file_path=p.e2k_file_path,
            canonical_model_path=p.canonical_model_path,
            validation_status=p.validation_status,
            created_at=p.created_at.isoformat(),
            updated_at=p.updated_at.isoformat(),
        )


class JobOut(BaseModel):
    id: str
    analysis_type: str
    status: str
    result_path: str | None
    result_summary: dict | None
    error_message: str | None
    created_at: str
    finished_at: str | None

    @classmethod
    def from_orm_extra(cls, j: StructuralJob) -> "JobOut":
        # Varios tasks guardan result_summary con json.dumps(...) en una
        # columna SQLAlchemy JSON — la BD lo persiste como string y lo
        # devuelve como str al leer. Se re-parsea aquí para que el schema
        # Pydantic (dict | None) no rechace la respuesta.
        raw = j.result_summary
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (ValueError, TypeError):
                raw = None
        return cls(
            id=j.id,
            analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=raw,
            error_message=j.error_message,
            created_at=j.created_at.isoformat(),
            finished_at=j.finished_at.isoformat() if j.finished_at else None,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _save_upload(file: UploadFile, project_id: str, subfolder: str) -> str:
    dest_dir = os.path.join(settings.upload_dir, "structural", str(project_id), subfolder)
    os.makedirs(dest_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex}_{file.filename}"
    dest_path = os.path.join(dest_dir, filename)
    with open(dest_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return dest_path


def _get_project_or_404(db: Session, project_id: str, user: User) -> StructuralProject:
    project = db.get(StructuralProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ProjectOut])
def list_projects(user: CurrentUser, db: DB):
    projects = (
        db.query(StructuralProject)
        .filter(StructuralProject.owner_id == user.id)
        .order_by(StructuralProject.updated_at.desc())
        .all()
    )
    return [ProjectOut.from_orm_extra(p) for p in projects]


def _seed_empty_canonical_model() -> dict:
    """Modelo canonico vacio pero valido. Sirve de punto de arranque para
    proyectos construidos desde cero (sin import ETABS/E2K).

    Estructura minima que satisface a `_load_canonical()` del editor y a
    `FullModelData` del frontend. El usuario poblara joints/frames/shells/
    materiales/secciones via los endpoints de structural_editor.py.
    """
    return {
        "schema_version": "1.0",
        "metadata": {
            "n_stories":    0,
            "n_joints":     0,
            "n_frames":     0,
            "n_shells":     0,
            "n_sections":   0,
            "n_materials":  0,
            "story_names":   [],
            "total_height_m": 0.0,
            "load_patterns": [],
        },
        "stories":    {},
        "joints":     {},
        "restraints": {},
        "sections":   {},
        "materials":  {},
        "frames":     {},
        "shells":     {},
        "masses":     {},
        "grid":        {"axes_x": [], "axes_y": [], "stories": []},
        "masonryMaterials": {},
        "infills":    {},
        "line_loads":  {},   # {frame_id: {pattern: wz_kN_m}}
        "shell_loads": {},   # {shell_id: {pattern: kN_m2}}
    }


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectCreate, user: CurrentUser, db: DB):
    project = StructuralProject(
        owner_id=user.id,
        name=payload.name,
        description=payload.description,
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    # Sembrar modelo canonico vacio para habilitar "modelar desde cero".
    # Si luego el usuario importa ETABS/E2K, el import_validate_task lo
    # sobrescribe con el modelo parseado.
    from app.tasks.structural_helpers import prepare_work_dir

    work_dir = prepare_work_dir(project.id, settings.upload_dir)
    canonical_path = os.path.join(work_dir, "canonical", "structural_model.json")
    try:
        with open(canonical_path, "w", encoding="utf-8") as f:
            json.dump(_seed_empty_canonical_model(), f, ensure_ascii=False, indent=2)
        project.canonical_model_path = canonical_path
        project.validation_status = "ok"
        db.commit()
        db.refresh(project)
    except Exception as e:
        # Si falla la siembra (p.ej. permisos de disco), el proyecto sigue
        # existiendo pero en estado "not_run" — el usuario puede importar un
        # modelo para recuperar el flujo.
        print(f"[create_project] seed_empty_canonical failed for {project.id}: {e}")

    return ProjectOut.from_orm_extra(project)


# ── DEMO: portico metalico 2x2 ejes, 2 pisos ─────────────────────────────────

@router.post("/demo/steel-portal", response_model=ProjectOut, status_code=201)
def create_demo_steel_portal(user: CurrentUser, db: DB):
    """Crea un proyecto de demostración completo: pórtico metálico 2×2 ejes
    por 2 pisos (W14X90 columnas + W18X50 vigas, A992). Grid, materiales,
    secciones, joints, frames, parámetros NSR-10 y una carga de servicio
    distribuida — todo pre-configurado para que al abrir el proyecto puedas
    correr Modal + Spectral de inmediato."""
    from engine.sections.steel_section import make_steel_section
    from app.tasks.structural_helpers import prepare_work_dir

    # 1. Crear el proyecto base (siembra canonical vacío + validation="ok")
    project = StructuralProject(
        owner_id=user.id,
        name="Demo pórtico acero 2×2×2",
        description="Pórtico metálico 2 ejes × 2 ejes × 2 pisos. "
                    "W14X90 columnas + W18X50 vigas, A992. "
                    "Pre-configurado para correr Modal + Spectral NSR-10.",
    )
    db.add(project); db.commit(); db.refresh(project)

    work_dir = prepare_work_dir(project.id, settings.upload_dir)
    canonical_path = os.path.join(work_dir, "canonical", "structural_model.json")

    # 2. Construir el canonical completo
    m = _seed_empty_canonical_model()

    # Grid: 2 ejes X (A, B a 0 y 6 m), 2 ejes Y (1, 2 a 0 y 6 m), 2 pisos
    STORY_H = 3.0
    m["grid"] = {
        "axes_x":  [{"name": "A", "coord_m": 0.0}, {"name": "B", "coord_m": 6.0}],
        "axes_y":  [{"name": "1", "coord_m": 0.0}, {"name": "2", "coord_m": 6.0}],
        "stories": [{"name": "N1", "height_m": STORY_H},
                    {"name": "N2", "height_m": STORY_H}],
    }
    m["stories"] = {
        "N1": {"elevation_m": STORY_H,     "height_m": STORY_H},
        "N2": {"elevation_m": 2 * STORY_H, "height_m": STORY_H},
    }

    # Material + secciones de acero (A992 por default)
    col_sf = make_steel_section("W14X90", "A992")
    bm_sf  = make_steel_section("W18X50", "A992")

    m["materials"]["Steel_A992"] = {
        "type":    "steel",
        "fpc_mpa": 0.0,
        "fy_mpa":  round(col_sf.material.fy, 2),
        "fu_mpa":  round(col_sf.material.fu, 2),
        "E_mpa":   round(col_sf.material.E0, 1),
        "G_mpa":   round(col_sf.material.G,  1),
    }

    def _steel_sec_dict(sf, shape_name: str) -> dict:
        return {
            "material":    "Steel_A992",
            "shape":       "steel",
            "shape_type":  "steel",
            "steel_grade": "A992",
            "steel_shape": shape_name,
            "aisc_type":   sf.type.value,
            "h_m":    round(sf.shape.d  * 1e-3, 4),
            "b_m":    round(sf.shape.bf * 1e-3, 4),
            "tw_m":   round(sf.shape.tw * 1e-3, 5),
            "tf_m":   round(sf.shape.tf * 1e-3, 5),
            "t_des_m": round(sf.shape.t_des * 1e-3, 5),
            "OD_m":   round(sf.shape.OD * 1e-3, 4),
            "A_m2":   round(sf.A  * 1e-6, 8),
            "I33_m4": round(sf.Iz * 1e-12, 12),
            "I22_m4": round(sf.Iy * 1e-12, 12),
            "J_m4":   round(sf.J  * 1e-12, 12),
            "E_mpa":  round(sf.E, 1),
            "G_mpa":  round(sf.G, 1),
            "Zx_m3":  round(sf.Zx * 1e-9, 9),
            "Zy_m3":  round(sf.Zy * 1e-9, 9),
            "Sx_m3":  round(sf.Sx * 1e-9, 9),
            "Sy_m3":  round(sf.Sy * 1e-9, 9),
            "Mp_x_kNm": round(sf.Mp_x * 1e-6, 2),
            "Mp_y_kNm": round(sf.Mp_y * 1e-6, 2),
            "Py_kN":    round(sf.Py  * 1e-3, 2),
        }

    m["sections"]["COL-W14X90"] = _steel_sec_dict(col_sf, "W14X90")
    m["sections"]["VIG-W18X50"] = _steel_sec_dict(bm_sf,  "W18X50")

    # Joints (12 total): 4 base empotrados + 4 en N1 + 4 en N2
    # Nombrado J_<x>_<y>_<z>
    axes_x = [("A", 0.0), ("B", 6.0)]
    axes_y = [("1", 0.0), ("2", 6.0)]
    elev = [("base", 0.0, True), ("N1", STORY_H, False), ("N2", 2 * STORY_H, False)]
    for (ax, x) in axes_x:
        for (ay, y) in axes_y:
            for (sname, z, is_base) in elev:
                jid = f"J_{ax}{ay}_{sname}"
                story = "" if is_base else sname
                jd = {
                    "x": x, "y": y, "z": z, "story": story,
                    "is_restrained": is_base,
                }
                m["joints"][jid] = jd
                if is_base:
                    m.setdefault("restraints", {})[jid] = [1, 1, 1, 1, 1, 1]

    # Frames: columnas (vertical z) + vigas (horizontal X e Y) por piso
    stories_order = [("base", 0.0), ("N1", STORY_H), ("N2", 2 * STORY_H)]
    # Columnas: pisan de base a N1, luego N1 a N2
    for i in range(len(stories_order) - 1):
        s_bot, _ = stories_order[i]
        s_top, _ = stories_order[i + 1]
        for (ax, _) in axes_x:
            for (ay, _) in axes_y:
                j_i = f"J_{ax}{ay}_{s_bot}"
                j_j = f"J_{ax}{ay}_{s_top}"
                fid = f"C_{ax}{ay}_{s_top}"
                m["frames"][fid] = {
                    "joint_i":      j_i,
                    "joint_j":      j_j,
                    "element_type": "column",
                    "story":        s_top,
                    "section":      "COL-W14X90",
                }

    # Vigas: en cada piso superior (N1, N2), 2 en dirección Y (vanos A1-A2, B1-B2)
    # y 2 en dirección X (vanos A1-B1, A2-B2)
    for s_top in ("N1", "N2"):
        # Dirección Y
        for (ax, _) in axes_x:
            j_i = f"J_{ax}1_{s_top}"
            j_j = f"J_{ax}2_{s_top}"
            fid = f"B_{ax}Y_{s_top}"
            m["frames"][fid] = {
                "joint_i": j_i, "joint_j": j_j,
                "element_type": "beam", "story": s_top,
                "section": "VIG-W18X50",
            }
        # Dirección X
        for (ay, _) in axes_y:
            j_i = f"J_A{ay}_{s_top}"
            j_j = f"J_B{ay}_{s_top}"
            fid = f"B_{ay}X_{s_top}"
            m["frames"][fid] = {
                "joint_i": j_i, "joint_j": j_j,
                "element_type": "beam", "story": s_top,
                "section": "VIG-W18X50",
            }

    # Patrones de carga + carga uniforme en vigas
    m["metadata"]["load_patterns"] = ["DL", "LL"]
    m.setdefault("line_loads", {})
    for fid, fd in m["frames"].items():
        if fd["element_type"] == "beam":
            m["line_loads"][fid] = {"DL": -12.0, "LL": -5.0}  # kN/m

    # Diafragmas rígidos en los 2 pisos (comportamiento ETABS default)
    m["metadata"]["rigid_diaphragms"] = ["N1", "N2"]

    # Update metadata counts
    m["metadata"]["n_stories"]    = 2
    m["metadata"]["n_joints"]     = len(m["joints"])
    m["metadata"]["n_frames"]     = len(m["frames"])
    m["metadata"]["n_materials"]  = len(m["materials"])
    m["metadata"]["n_sections"]   = len(m["sections"])
    m["metadata"]["story_names"]  = ["N1", "N2"]
    m["metadata"]["total_height_m"] = 2 * STORY_H

    # 3. Persistir canonical
    with open(canonical_path, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    project.canonical_model_path = canonical_path
    project.validation_status = "ok"

    # 4. Parámetros sísmicos NSR-10 Bogotá, pórtico metálico DMO
    project.parameters_json = json.dumps({
        "code":               "NSR-10",
        "city":               "Bogotá",
        "department":         "Cundinamarca",
        "Aa":                 0.15,
        "Av":                 0.20,
        "soil_type":          "D",
        "edification_use":    "II",
        "importance_factor":  1.0,
        "structure_system":   "SMF",     # Steel Moment Frame
        "energy_dissipation": "DMO",
        "R":                  5.0,       # NSR-10 F.3 / AISC 341 DMO
        "damping_ratio":      0.02,      # 2% típico para acero
        "n_modes":            12,
        "combination_method": "CQC",
    }, ensure_ascii=False)

    db.commit(); db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user: CurrentUser, db: DB):
    return ProjectOut.from_orm_extra(_get_project_or_404(db, project_id, user))


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, payload: ProjectUpdate, user: CurrentUser, db: DB):
    """Renombra o ajusta la descripción. Solo aplica cambios a campos presentes
    en el body (patch parcial). No modifica parámetros sísmicos ni archivos."""
    project = _get_project_or_404(db, project_id, user)

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="El nombre no puede estar vacío")
        project.name = name

    if payload.description is not None:
        desc = payload.description.strip()
        project.description = desc or None

    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, user: CurrentUser, db: DB):
    """Elimina el proyecto, sus jobs (cascade de SQLAlchemy) y los archivos
    subidos en disco (XLSX ETABS, .e2k, rebar, modelo canónico, resultados)."""
    project = _get_project_or_404(db, project_id, user)
    db.delete(project)
    db.commit()

    # Limpiar el directorio del proyecto en disco. No es crítico si falla;
    # los jobs ya quedaron huérfanos en DB y no hay vuelta atrás.
    project_dir = os.path.join(settings.upload_dir, str(project_id))
    if os.path.isdir(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)


@router.put("/{project_id}/parameters", response_model=ProjectOut)
def save_parameters(project_id: str, payload: SeismicParameters, user: CurrentUser, db: DB):
    """Guarda los parámetros sísmicos NSR-10 del proyecto."""
    project = _get_project_or_404(db, project_id, user)
    project.parameters_json = json.dumps(payload.model_dump(), ensure_ascii=False)
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.post("/{project_id}/upload-model", response_model=ProjectOut)
async def upload_model_file(
    project_id: str,
    user: CurrentUser,
    db: DB,
    model_file: UploadFile = File(..., description="XLSX exportado de ETABS"),
):
    """Sube el archivo XLSX de ETABS. Reinicia el estado de validación."""
    project = _get_project_or_404(db, project_id, user)
    if not (model_file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .xlsx")
    path = _save_upload(model_file, project_id, "model")
    project.input_file_path  = path
    project.validation_status = "not_run"
    project.canonical_model_path = None
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.post("/{project_id}/upload-e2k", response_model=ProjectOut)
async def upload_e2k_file(
    project_id: str,
    user: CurrentUser,
    db: DB,
    e2k_file: UploadFile = File(..., description="Archivo .e2k exportado de ETABS"),
):
    """Sube el archivo .e2k de ETABS (alternativa al XLSX). Reinicia el estado de validación."""
    project = _get_project_or_404(db, project_id, user)
    if not (e2k_file.filename or "").lower().endswith(".e2k"):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .e2k")
    path = _save_upload(e2k_file, project_id, "e2k")
    project.e2k_file_path     = path
    project.validation_status = "not_run"
    project.canonical_model_path = None
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.get("/{project_id}/jobs", response_model=list[JobOut])
def list_project_jobs(project_id: str, user: CurrentUser, db: DB):
    """Lista todos los jobs de análisis del proyecto, más recientes primero."""
    _get_project_or_404(db, project_id, user)
    jobs = (
        db.query(StructuralJob)
        .filter(StructuralJob.project_id == project_id)
        .order_by(StructuralJob.created_at.desc())
        .all()
    )
    return [JobOut.from_orm_extra(j) for j in jobs]


class CombinationsIn(BaseModel):
    selected_ids: list[str]


class SpectrumPreviewRequest(BaseModel):
    Aa: float
    Av: float
    soil_type: str    # A / B / C / D / E
    T_max: float = 4.0


@router.get("/{project_id}/model-geometry")
def model_geometry(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna la geometría simplificada del modelo canónico para visualización 3D.
    Solo disponible cuando el modelo ha sido importado y validado.
    """
    project = _get_project_or_404(db, project_id, user)
    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        raise HTTPException(status_code=404, detail="El modelo canónico no está disponible. Valida el modelo primero.")

    with open(project.canonical_model_path, encoding="utf-8") as f:
        model = json.load(f)

    joints_full = model.get("joints", {})
    frames_full = model.get("frames", {})
    stories_full = model.get("stories", {})
    metadata = model.get("metadata", {})

    joints_slim = {
        lbl: {
            "x": jd["x"], "y": jd["y"], "z": jd["z"],
            "story": jd.get("story", ""),
            "is_restrained": jd.get("is_restrained", False),
        }
        for lbl, jd in joints_full.items()
    }

    frames_slim = {
        lbl: {
            "joint_i":    fd["joint_i"],
            "joint_j":    fd["joint_j"],
            "element_type": fd.get("element_type", "beam"),
            "story":      fd.get("story", ""),
            "section":    fd.get("section", ""),
        }
        for lbl, fd in frames_full.items()
    }

    masses_full = model.get("masses", {})
    masses_slim = {
        k: {
            "story":     md["story"],
            "mass_x_t":  md.get("mass_x_t", 0.0),
            "x_cm_m":    md.get("x_cm_m", 0.0),
            "y_cm_m":    md.get("y_cm_m", 0.0),
            "z_m":       md.get("z_m", 0.0),
        }
        for k, md in masses_full.items()
    }

    shells_full = model.get("shells", {})
    shells_slim = {
        lbl: {
            "joints":         sd["joints"],
            "element_type":   sd.get("element_type", "slab"),
            "story":          sd.get("story", ""),
            "section":        sd.get("section", ""),
            "thickness_m":    sd.get("thickness_m", 0.0),
            "pier":           sd.get("pier", ""),
            "is_planar":      sd.get("is_planar", True),
            "out_of_plane_m": sd.get("out_of_plane_m", 0.0),
        }
        for lbl, sd in shells_full.items()
    }

    return {
        "joints":        joints_slim,
        "frames":        frames_slim,
        "shells":        shells_slim,
        "stories":       stories_full,
        "masses":        masses_slim,
        "load_patterns": metadata.get("load_patterns", []),
        "shell_loads":   model.get("shell_loads", {}),
        "n_joints":      len(joints_slim),
        "n_frames":      len(frames_slim),
        "n_shells":      len(shells_slim),
        "n_stories":     len(stories_full),
    }


@router.get("/{project_id}/combinations")
def get_combinations(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna el catálogo completo de combinaciones NSR-10 B.3.4 y los IDs
    actualmente seleccionados para este proyecto.
    """
    from engine.building.design.combinations import NSR10_COMBINATIONS, DEFAULT_SELECTED_IDS
    project = _get_project_or_404(db, project_id, user)
    params = json.loads(project.parameters_json) if project.parameters_json else {}
    selected = params.get("combinations", DEFAULT_SELECTED_IDS)
    return {"combinations": NSR10_COMBINATIONS, "selected_ids": selected}


@router.put("/{project_id}/combinations")
def save_combinations(project_id: str, payload: CombinationsIn, user: CurrentUser, db: DB):
    """Persiste los IDs de combinaciones seleccionadas dentro de parameters_json."""
    from engine.building.design.combinations import validate_selected_ids
    project = _get_project_or_404(db, project_id, user)
    params = json.loads(project.parameters_json) if project.parameters_json else {}
    params["combinations"] = validate_selected_ids(payload.selected_ids)
    project.parameters_json = json.dumps(params, ensure_ascii=False)
    db.commit()
    return {"selected_ids": params["combinations"]}


@router.post("/{project_id}/spectrum-preview")
def spectrum_preview(project_id: str, payload: SpectrumPreviewRequest, user: CurrentUser, db: DB):
    """Genera el espectro NSR-10 para previsualización (sin guardar en BD)."""
    _get_project_or_404(db, project_id, user)
    from engine.seismic.spectrum import compute_spectrum
    result = compute_spectrum(
        Aa=payload.Aa,
        Av=payload.Av,
        soil_type=payload.soil_type,
        T_max=payload.T_max,
        n_points=300,
    )
    return result


# ── Export / Import de proyectos ──────────────────────────────────────────────
# Formato .plabs.json autocontenido para compartir modelos entre cuentas.

_PLABS_FORMAT_VERSION = 1

# Artefactos ligeros que viajan con el modelo si include_design=True.
# Rutas relativas al work_dir del proyecto.
_DESIGN_ARTIFACTS: tuple[tuple[str, str], ...] = (
    ("design_columns_results.json",  "results/design_columns_results.json"),
    ("design_columns_detail.json",   "results/design_columns_detail.json"),
    ("beam_design_results.json",     "results/beam_design_results.json"),
    ("beam_design_detail.json",      "results/beam_design_detail.json"),
    ("wall_demands.json",            "results/wall_demands.json"),
    ("wall_design_results.json",     "results/wall_design_results.json"),
    ("wall_design_detail.json",      "results/wall_design_detail.json"),
    ("nonlinear_model.json",         "nonlinear/nonlinear_model.json"),
)


def _safe_filename(name: str) -> str:
    """Nombre seguro para Content-Disposition (ASCII, sin separadores)."""
    base = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    return (base or "model")[:80]


@router.get("/{project_id}/export")
def export_project(
    project_id:        str,
    user:              CurrentUser,
    db:                DB,
    include_reinforcement: bool = True,
    include_design:        bool = True,
):
    """
    Exporta el proyecto completo como un archivo .plabs.json autocontenido.

    Incluido siempre:
      - metadata (format_version, exported_at, exported_by, source_project_id)
      - project (name, description, parameters, validation_status)
      - canonical_model (todo el structural_model.json)

    Flags:
      - include_reinforcement: refuerzo definitivo (reinforcement.json)
      - include_design:        artefactos de diseño (columns/beams/walls) + spec no lineal

    NO incluye resultados pesados (NPZ de pushover, modal, dinámico) — se recomputan en destino.
    """
    from fastapi.responses import JSONResponse

    project = _get_project_or_404(db, project_id, user)
    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        raise HTTPException(
            status_code=400,
            detail="El modelo canónico no está disponible. Valida el modelo antes de exportar.",
        )

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

    def _load_json(path: str) -> dict | list | None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    canonical = _load_json(project.canonical_model_path) or {}

    parameters = None
    if project.parameters_json:
        try:
            parameters = json.loads(project.parameters_json)
        except ValueError:
            parameters = None

    payload: dict = {
        "format_version":   _PLABS_FORMAT_VERSION,
        "exported_at":      _utc_now_iso(),
        "exported_by":      user.email,
        "source_project_id": project.id,
        "project": {
            "name":              project.name,
            "description":       project.description,
            "parameters":        parameters,
            "validation_status": project.validation_status,
        },
        "canonical_model":  canonical,
        "artifacts":        {},
    }

    if include_reinforcement:
        reinf = _load_json(os.path.join(work_dir, "results", "reinforcement.json"))
        if reinf is not None:
            payload["artifacts"]["reinforcement.json"] = reinf

    if include_design:
        for rel_key, rel_path in _DESIGN_ARTIFACTS:
            content = _load_json(os.path.join(work_dir, rel_path))
            if content is not None:
                payload["artifacts"][rel_key] = content

    fname = f"{_safe_filename(project.name)}.plabs.json"
    return JSONResponse(
        content=payload,
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
        },
    )


@router.post("/import", response_model=ProjectOut, status_code=201)
async def import_project(
    user:         CurrentUser,
    db:           DB,
    file:         UploadFile = File(..., description="Archivo .plabs.json exportado"),
):
    """
    Importa un modelo exportado desde otra cuenta/instalación.

    Crea un StructuralProject nuevo (nuevo UUID, owner=usuario actual), reconstruye
    el work_dir con canonical_model.json + los artefactos incluidos, y devuelve el
    proyecto creado.

    El archivo original NO se guarda; solo se reconstruye el modelo canónico y
    los JSONs ligeros. Resultados pesados (pushover, modal, dinámico) se vuelven
    a correr en la cuenta destino.
    """
    name = (file.filename or "").lower()
    if not (name.endswith(".plabs.json") or name.endswith(".json")):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .plabs.json o .json.")

    try:
        raw = await file.read()
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"JSON inválido: {exc}") from exc

    fmt = payload.get("format_version")
    if fmt != _PLABS_FORMAT_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"format_version={fmt!r} no soportada. Esperada: {_PLABS_FORMAT_VERSION}.",
        )

    proj_meta = payload.get("project") or {}
    canonical = payload.get("canonical_model")
    if not isinstance(canonical, dict) or not canonical:
        raise HTTPException(status_code=400, detail="El archivo no contiene canonical_model.")

    # Crear el proyecto con nuevo UUID
    new_name = (proj_meta.get("name") or "Modelo importado").strip() or "Modelo importado"
    params   = proj_meta.get("parameters")
    project = StructuralProject(
        owner_id=user.id,
        name=new_name,
        description=proj_meta.get("description"),
        parameters_json=(json.dumps(params, ensure_ascii=False) if params else None),
        validation_status=proj_meta.get("validation_status") or "ok",
    )
    db.add(project)
    db.flush()  # obtener el id antes del commit

    # Reconstruir work_dir
    from app.tasks.structural_helpers import prepare_work_dir
    work_dir      = prepare_work_dir(project.id, settings.upload_dir)
    canonical_dir = os.path.join(work_dir, "canonical")
    results_dir   = os.path.join(work_dir, "results")

    canonical_path = os.path.join(canonical_dir, "structural_model.json")
    with open(canonical_path, "w", encoding="utf-8") as f:
        json.dump(canonical, f, ensure_ascii=False, indent=2)
    project.canonical_model_path = canonical_path

    # Escribir artefactos
    artifacts = payload.get("artifacts") or {}

    def _write_rel(rel_path: str, content) -> None:
        dest = os.path.join(work_dir, rel_path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(content, fh, ensure_ascii=False, indent=2)

    if "reinforcement.json" in artifacts:
        _write_rel("results/reinforcement.json", artifacts["reinforcement.json"])

    rel_by_key = {k: p for k, p in _DESIGN_ARTIFACTS}
    for key, content in artifacts.items():
        if key in rel_by_key:
            _write_rel(rel_by_key[key], content)

    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
