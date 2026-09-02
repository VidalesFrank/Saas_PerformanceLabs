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
        return cls(
            id=j.id,
            analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=j.result_summary,
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
    return ProjectOut.from_orm_extra(project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user: CurrentUser, db: DB):
    return ProjectOut.from_orm_extra(_get_project_or_404(db, project_id, user))


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, user: CurrentUser, db: DB):
    project = _get_project_or_404(db, project_id, user)
    db.delete(project)
    db.commit()


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

    return {
        "joints":        joints_slim,
        "frames":        frames_slim,
        "stories":       stories_full,
        "load_patterns": metadata.get("load_patterns", []),
        "n_joints":      len(joints_slim),
        "n_frames":      len(frames_slim),
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
