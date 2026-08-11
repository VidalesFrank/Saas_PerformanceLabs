"""
Router — Módulo 1: Lanzamiento, estado y resultados de análisis estructural.

Prefix: /api/v1/projects/analysis
Auth:   JWT requerido en todos los endpoints.

Flujo de análisis:
  import_validate → modal → spectral

Cada etapa es un job Celery independiente. El frontend hace polling cada 3s.
"""
import json
import os
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import (
    StructuralProject, StructuralJob,
    StructuralAnalysisType, StructuralJobStatus, User,
)

router = APIRouter(prefix="/api/v1/projects/analysis", tags=["structural-analysis"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class LaunchRequest(BaseModel):
    project_id:    str
    analysis_type: StructuralAnalysisType
    extra_params:  dict | None = None    # parámetros adicionales específicos de la tarea


class JobOut(BaseModel):
    id: str
    celery_task_id: str | None
    analysis_type: str
    status: str
    result_path: str | None
    result_summary: dict | None
    error_message: str | None
    project_id: str
    created_at: str
    finished_at: str | None

    @classmethod
    def from_orm(cls, j: StructuralJob) -> "JobOut":
        return cls(
            id=j.id,
            celery_task_id=j.celery_task_id,
            analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=j.result_summary,
            error_message=j.error_message,
            project_id=j.project_id,
            created_at=j.created_at.isoformat(),
            finished_at=j.finished_at.isoformat() if j.finished_at else None,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project(db: Session, project_id: str, user: User) -> StructuralProject:
    project = db.get(StructuralProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


def _get_job(db: Session, job_id: str, user: User) -> StructuralJob:
    job = db.get(StructuralJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job no encontrado")
    project = db.get(StructuralProject, job.project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este job")
    return job


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/launch", response_model=JobOut, status_code=201)
def launch_analysis(payload: LaunchRequest, user: CurrentUser, db: DB):
    """
    Lanza un análisis en background vía Celery.

    Orden requerido: import_validate → modal → spectral.
    El backend valida que exista el archivo de entrada para import_validate,
    y que haya un modelo canónico para modal y spectral.
    """
    project = _get_project(db, payload.project_id, user)

    # Validaciones de prerequisitos por tipo de análisis
    if payload.analysis_type == StructuralAnalysisType.import_validate:
        has_file = bool(project.input_file_path) or bool(project.e2k_file_path)
        if not has_file:
            raise HTTPException(
                status_code=400,
                detail="Sube un archivo de modelo (.xlsx o .e2k) antes de validar.",
            )

    elif payload.analysis_type == StructuralAnalysisType.modal:
        if project.validation_status not in ("ok", "has_warnings"):
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar validado (sin errores críticos) antes del análisis modal.",
            )

    elif payload.analysis_type == StructuralAnalysisType.spectral:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="Ejecuta el análisis modal primero.",
            )
        if not project.parameters_json:
            raise HTTPException(
                status_code=400,
                detail="Configura los parámetros sísmicos NSR-10 antes del análisis espectral.",
            )

    # Crear el registro del job
    job = StructuralJob(
        analysis_type=payload.analysis_type,
        status=StructuralJobStatus.pending,
        project_id=payload.project_id,
        owner_id=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Despachar a Celery
    try:
        from app.tasks.celery_app import celery_app

        parameters_dict = None
        if project.parameters_json:
            try:
                parameters_dict = json.loads(project.parameters_json)
            except Exception:
                pass

        task_map = {
            StructuralAnalysisType.import_validate: "app.tasks.structural_import_task.run_import",
            StructuralAnalysisType.modal:           "app.tasks.structural_modal_task.run_modal",
            StructuralAnalysisType.spectral:        "app.tasks.structural_spectral_task.run_spectral",
        }

        kwargs: dict = {
            "job_id":          job.id,
            "project_id":      project.id,
            "input_file":      project.input_file_path,
            "parameters_dict": parameters_dict,
        }
        # e2k_file solo lo necesita run_import; no enviarlo a modal/spectral
        if payload.analysis_type == StructuralAnalysisType.import_validate:
            kwargs["e2k_file"] = project.e2k_file_path
        if payload.extra_params:
            kwargs["extra_params"] = payload.extra_params

        task = celery_app.send_task(task_map[payload.analysis_type], kwargs=kwargs)
        job.celery_task_id = task.id
        db.commit()
        db.refresh(job)

    except Exception as e:
        job.status = StructuralJobStatus.failed
        job.error_message = str(e)[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Error al despachar tarea Celery: {e}")

    return JobOut.from_orm(job)


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job_status(job_id: str, user: CurrentUser, db: DB):
    """Consulta el estado de un job (polling desde el frontend cada 3s)."""
    return JobOut.from_orm(_get_job(db, job_id, user))


@router.get("/jobs/{job_id}/result")
def get_job_result(job_id: str, user: CurrentUser, db: DB):
    """Retorna el resultado de un job completado. JSON → objeto. Otros → FileResponse."""
    job = _get_job(db, job_id, user)
    if job.status != StructuralJobStatus.success:
        raise HTTPException(
            status_code=400,
            detail=f"El job aún no completó. Estado: {job.status.value}",
        )
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado")

    if job.result_path.endswith(".json"):
        with open(job.result_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return FileResponse(job.result_path, filename=os.path.basename(job.result_path))


@router.get("/jobs/{job_id}/download")
def download_job_result(job_id: str, user: CurrentUser, db: DB):
    """Fuerza la descarga del archivo de resultado."""
    job = _get_job(db, job_id, user)
    if job.status != StructuralJobStatus.success:
        raise HTTPException(status_code=400, detail="El job no ha completado")
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado")
    return FileResponse(
        job.result_path,
        filename=os.path.basename(job.result_path),
        media_type="application/octet-stream",
    )


@router.delete("/jobs/{job_id}/cancel", status_code=200)
def cancel_job(job_id: str, user: CurrentUser, db: DB):
    """Cancela un job activo (pending o running)."""
    job = _get_job(db, job_id, user)
    if job.status not in (StructuralJobStatus.pending, StructuralJobStatus.running):
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden cancelar jobs activos (pending o running)",
        )
    if job.celery_task_id:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(job.celery_task_id, terminate=True, signal="SIGTERM")
        except Exception:
            pass
    job.status = StructuralJobStatus.cancelled
    job.error_message = "Cancelado por el usuario"
    job.finished_at = datetime.now(timezone.utc)
    db.commit()
    return {"detail": "Job cancelado exitosamente"}
