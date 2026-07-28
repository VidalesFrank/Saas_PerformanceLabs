"""
Router — Proyectos de Análisis No Lineal 3D de Edificios.

Prefix: /api/v1/building/projects
Auth:   JWT requerido en todos los endpoints (get_current_user).

Cada usuario gestiona sus propios proyectos.
Los archivos se guardan en: UPLOAD_DIR/{project_id}/{subfolder}/
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
from app.models import BuildingProject, BuildingJob, User

router = APIRouter(prefix="/api/v1/building/projects", tags=["building-projects"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str | None = None


class ProjectParameters(BaseModel):
    """Parámetros estructurales y sísmicos del proyecto."""
    proyect_name:       str
    city:               str
    soil_type:          str           # A / B / C / D / E
    edification_use:    str           # I / II / III / IV
    construction_year:  int
    code:               str  = "NSR-10"
    structure_system:   str           # RCMRF / WRCF / DUAL
    confined_elements:  str  = "Si"
    energy_dissipation: str  = "DMO"
    integration_points: int  = 5
    load_case:          str  = "(0) 1CM + 0.25CV"
    cm_load:            str  = "DEAD"
    cv_load:            str  = "LIVE"
    shell_craking:      float = 1.0
    rebar_type:         str  = "Ingresado"   # Ingresado / Diseño ETABS


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    parameters_json: dict | None = None
    input_file_path: str | None
    e2k_file_path: str | None
    rebar_file_path: str | None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_extra(cls, p: BuildingProject) -> "ProjectOut":
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
            rebar_file_path=p.rebar_file_path,
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

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_extra(cls, j: BuildingJob) -> "JobOut":
        return cls(
            id=j.id, analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=j.result_summary,
            error_message=j.error_message,
            created_at=j.created_at.isoformat(),
            finished_at=j.finished_at.isoformat() if j.finished_at else None,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _save_upload(file: UploadFile, project_id: str, subfolder: str) -> str:
    dest_dir = os.path.join(settings.upload_dir, str(project_id), subfolder)
    os.makedirs(dest_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex}_{file.filename}"
    dest_path = os.path.join(dest_dir, filename)
    with open(dest_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return dest_path


def _get_project_or_404(db: Session, project_id: str, user: User) -> BuildingProject:
    project = db.get(BuildingProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ProjectOut])
def list_projects(user: CurrentUser, db: DB):
    projects = db.query(BuildingProject).filter(BuildingProject.owner_id == user.id).all()
    return [ProjectOut.from_orm_extra(p) for p in projects]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectCreate, user: CurrentUser, db: DB):
    project = BuildingProject(
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
def save_parameters(project_id: str, payload: ProjectParameters, user: CurrentUser, db: DB):
    """Guarda los parámetros estructurales del proyecto como JSON."""
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
    """Sube el archivo XLSX de ETABS (modelo estructural)."""
    project = _get_project_or_404(db, project_id, user)
    if not (model_file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .xlsx")
    path = _save_upload(model_file, project_id, "model")
    project.input_file_path = path
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.post("/{project_id}/upload-e2k", response_model=ProjectOut)
async def upload_e2k_file(
    project_id: str,
    user: CurrentUser,
    db: DB,
    e2k_file: UploadFile = File(..., description="Archivo .e2k de ETABS"),
):
    """Sube el archivo .e2k de ETABS (alternativa al XLSX directo)."""
    project = _get_project_or_404(db, project_id, user)
    if not (e2k_file.filename or "").lower().endswith(".e2k"):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .e2k")
    path = _save_upload(e2k_file, project_id, "e2k")
    project.e2k_file_path = path
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.post("/{project_id}/upload-rebar", response_model=ProjectOut)
async def upload_rebar_file(
    project_id: str,
    user: CurrentUser,
    db: DB,
    rebar_file: UploadFile = File(..., description="XLSX con diseño de refuerzo (para flujo .e2k)"),
):
    """Sube el XLSX con resultados de diseño de refuerzo (complemento al .e2k)."""
    project = _get_project_or_404(db, project_id, user)
    if not (rebar_file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos .xlsx")
    path = _save_upload(rebar_file, project_id, "rebar")
    project.rebar_file_path = path
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_extra(project)


@router.get("/{project_id}/jobs", response_model=list[JobOut])
def list_project_jobs(project_id: str, user: CurrentUser, db: DB):
    """Lista todos los jobs de análisis de un proyecto, ordenados por fecha."""
    _get_project_or_404(db, project_id, user)
    jobs = (
        db.query(BuildingJob)
        .filter(BuildingJob.project_id == project_id)
        .order_by(BuildingJob.created_at.desc())
        .all()
    )
    return [JobOut.from_orm_extra(j) for j in jobs]
